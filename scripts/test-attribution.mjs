// Reklam → Hasta Atfetme: end-to-end checks against a REAL database.
//
// Unlike the suites in `npm test`, this one needs DATABASE_URL — it exercises
// the actual SQL (first-touch claim, FX-converted revenue, back-fill), which
// is exactly where attribution would break silently. Every row it creates is
// removed in the finally block, including on failure.
//
// Run: DATABASE_URL=... npm run check:attribution
import { pool } from '../src/db/pool.js';
import {
  createWidgetLead, attachLeadAttribution, getCampaignPerformance, resolveCampaignForLeads,
} from '../src/store/repository.js';

let failed = 0;
const check = (n, c, extra='') => { console.log(`  ${c?'✓':'✗'} ${n}${extra?'  '+extra:''}`); if(!c) failed++; };
const made = { leads: [], campaigns: [] };

try {
  const { rows:[clinic] } = await pool.query('SELECT id FROM clinics LIMIT 1');

  // A registered campaign: €1000 spend, ad id ATTR_TEST_AD_1
  const { rows:[camp] } = await pool.query(
    `INSERT INTO campaigns (clinic_id, name, channel, spend, clicks, external_ref)
     VALUES ($1,'ATTR TEST Instagram','instagram',1000,250,'ATTR_TEST_AD_1') RETURNING id`, [clinic.id]);
  made.campaigns.push(camp.id);

  console.log('\n▶ Widget lead with UTM attribution');
  const a = await createWidgetLead({ phone:'905559000101', name:'Attr Widget', treatment:'hair', consent:true });
  made.leads.push(a.leadId);
  const r1 = await attachLeadAttribution(a.leadId, {
    sourceId:'ATTR_TEST_AD_1', sourceType:'utm', sourceUrl:'https://x.test/?utm_campaign=ATTR_TEST_AD_1', headline:'Hair TR', ctwaClid:null });
  check('attribution recorded', !!r1);
  check('matched the registered campaign', r1.campaign_id === camp.id);

  console.log('\n▶ First touch wins (a later ad must not overwrite)');
  const r2 = await attachLeadAttribution(a.leadId, { sourceId:'ATTR_TEST_AD_LATER', sourceType:'ad' });
  check('second attribution refused', r2 === null);
  const { rows:[chk] } = await pool.query('SELECT ad_source_id FROM leads WHERE id=$1',[a.leadId]);
  check('original ad preserved', chk.ad_source_id === 'ATTR_TEST_AD_1', chk.ad_source_id);

  console.log('\n▶ WhatsApp Click-to-WhatsApp lead (Meta referral shape)');
  const b = await createWidgetLead({ phone:'905559000102', name:'Attr CTWA', treatment:'dental', consent:true });
  made.leads.push(b.leadId);
  await attachLeadAttribution(b.leadId, {
    sourceId:'ATTR_TEST_AD_1', sourceType:'ad', sourceUrl:'https://fb.test/ad', headline:'Dental TR', ctwaClid:'CTWA_XYZ' });
  // Booked + paid €1,300 so ROAS has something real to divide
  await pool.query(`UPDATE leads SET status='booked' WHERE id=$1`, [b.leadId]);
  await pool.query(
    `INSERT INTO payments (clinic_id, lead_id, amount, currency, type, status, paid_at)
     VALUES ($1,$2,1300,'EUR','deposit','paid',now())`, [clinic.id, b.leadId]);

  console.log('\n▶ Unregistered ad is kept, not discarded');
  const c = await createWidgetLead({ phone:'905559000103', name:'Attr Unknown', treatment:'nose', consent:true });
  made.leads.push(c.leadId);
  const r3 = await attachLeadAttribution(c.leadId, { sourceId:'ATTR_TEST_AD_UNREGISTERED', sourceType:'ad', headline:'Rhino DE' });
  check('stored even with no campaign row', !!r3 && r3.campaign_id === null);

  console.log('\n▶ getCampaignPerformance() maths');
  const perf = await getCampaignPerformance();
  const row = perf.campaigns.find(x => x.id === camp.id);
  check('campaign present', !!row);
  check('2 leads attributed', row.leads === 2, `leads=${row.leads}`);
  check('1 booked', row.booked === 1, `booked=${row.booked}`);
  check('CAC = 1000/2 = 500', row.cac_eur === 500, `cac=${row.cac_eur}`);
  check('cost per booking = 1000/1 = 1000', row.cost_per_booking_eur === 1000, `cpb=${row.cost_per_booking_eur}`);
  check('revenue = 1300 EUR', row.revenue_eur === 1300, `rev=${row.revenue_eur}`);
  check('ROAS = 1300/1000 = 1.3', row.roas === 1.3, `roas=${row.roas}`);
  check('conversion = 1/2 = 50%', row.conversion_pct === 50, `conv=${row.conversion_pct}`);
  const un = perf.unmatched_ads.find(u => u.ad_source_id === 'ATTR_TEST_AD_UNREGISTERED');
  check('unregistered ad surfaced, not hidden', !!un && un.leads === 1);

  console.log('\n▶ Zero-denominator campaigns report null, never a flattering 0');
  const { rows:[empty] } = await pool.query(
    `INSERT INTO campaigns (clinic_id,name,channel,spend,clicks,external_ref)
     VALUES ($1,'ATTR TEST Empty','google',500,10,'ATTR_TEST_AD_EMPTY') RETURNING id`, [clinic.id]);
  made.campaigns.push(empty.id);
  const perf2 = await getCampaignPerformance();
  const e = perf2.campaigns.find(x => x.id === empty.id);
  check('CAC null (not 0) with no leads', e.cac_eur === null);
  check('ROAS 0 with spend but no revenue', e.roas === 0, `roas=${e.roas}`);

  console.log('\n▶ Back-fill links leads captured before the campaign existed');
  const n = await resolveCampaignForLeads(empty.id, 'ATTR_TEST_AD_UNREGISTERED');
  check('back-fill claimed the orphan lead', n === 1, `rows=${n}`);

  console.log(failed === 0 ? '\nALL ATTRIBUTION CHECKS PASSED' : `\n${failed} FAILED`);
} finally {
  for (const id of made.leads) {
    await pool.query('DELETE FROM payments WHERE lead_id=$1',[id]);
    await pool.query('DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE lead_id=$1)',[id]);
    await pool.query('DELETE FROM conversations WHERE lead_id=$1',[id]);
    await pool.query('DELETE FROM leads WHERE id=$1',[id]);
  }
  for (const id of made.campaigns) await pool.query('DELETE FROM campaigns WHERE id=$1',[id]);
  console.log(`cleaned up ${made.leads.length} leads, ${made.campaigns.length} campaigns`);
  await pool.end();
}
process.exit(failed === 0 ? 0 : 1);
