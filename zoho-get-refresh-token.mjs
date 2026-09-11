// zoho-get-refresh-token.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Zoho Self Client'tan aldığın KISA ÖMÜRLÜ kodu KALICI refresh_token'a çevirir.
//
// Kullanım:
//   node zoho-get-refresh-token.mjs <CLIENT_ID> <CLIENT_SECRET> <GRANT_CODE> [ACCOUNTS_HOST]
//
// ACCOUNTS_HOST (bölgene göre, vermezsen .com varsayılır):
//   EU → https://accounts.zoho.eu      IN → https://accounts.zoho.in
//   AU → https://accounts.zoho.com.au  US → https://accounts.zoho.com
//
// Grant code'u api-console.zoho.com → Self Client → Generate Code'dan alırsın.
// Kod ~3-10 dk geçerlidir, ürettikten hemen sonra bu komutu çalıştır.
// ─────────────────────────────────────────────────────────────────────────────

const [, , clientId, clientSecret, code, accountsHost = 'https://accounts.zoho.com'] = process.argv;

if (!clientId || !clientSecret || !code) {
  console.error(
    '\nEksik argüman.\n\n' +
      'Kullanım:\n' +
      '  node zoho-get-refresh-token.mjs <CLIENT_ID> <CLIENT_SECRET> <GRANT_CODE> [ACCOUNTS_HOST]\n',
  );
  process.exit(1);
}

const params = new URLSearchParams({
  grant_type: 'authorization_code',
  client_id: clientId,
  client_secret: clientSecret,
  code,
});

const res = await fetch(`${accountsHost}/oauth/v2/token`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: params.toString(),
});
const data = await res.json().catch(() => ({}));

if (!res.ok || !data.refresh_token) {
  console.error('\n❌ Refresh token alınamadı. Zoho yanıtı:\n', JSON.stringify(data, null, 2));
  console.error(
    '\nİpuçları: kod süresi dolmuş olabilir (yeni kod üret), ACCOUNTS_HOST bölgenle ' +
      'eşleşmiyor olabilir, ya da scope olarak ZohoCRM.modules.ALL seçtiğinden emin ol.\n',
  );
  process.exit(1);
}

const apiHostGuess = accountsHost.replace('accounts.zoho', 'www.zohoapis');

console.log('\n✅ Başarılı! Aşağıdaki satırları .env dosyana ekle:\n');
console.log(`ZOHO_CLIENT_ID=${clientId}`);
console.log(`ZOHO_CLIENT_SECRET=${clientSecret}`);
console.log(`ZOHO_REFRESH_TOKEN=${data.refresh_token}`);
console.log(`ZOHO_ACCOUNTS_HOST=${accountsHost}`);
console.log(`ZOHO_API_HOST=${apiHostGuess}`);
console.log('\n(refresh_token kalıcıdır — bir daha bu adımı yapman gerekmez.)\n');
