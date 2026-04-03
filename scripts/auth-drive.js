'use strict';

/**
 * One-time Google Drive OAuth2 authentication.
 * Run once on the server: node scripts/auth-drive.js
 * This will save token.json which is used by the upload agent.
 */

require('dotenv').config();
const { google } = require('googleapis');
const readline = require('readline');
const fs = require('fs');
const path = require('path');

const TOKEN_PATH = path.join(process.cwd(), 'token.json');

const SCOPES = ['https://www.googleapis.com/auth/drive.file'];

async function main() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error('❌ GOOGLE_CLIENT_ID dan GOOGLE_CLIENT_SECRET harus diisi di .env');
    process.exit(1);
  }

  const oauth2 = new google.auth.OAuth2(
    clientId,
    clientSecret,
    'urn:ietf:wg:oauth:2.0:oob'
  );

  const authUrl = oauth2.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
  });

  console.log('\n🔑 Buka URL ini di browser untuk authorize:');
  console.log('\n' + authUrl + '\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  rl.question('Masukkan authorization code dari browser: ', async (code) => {
    rl.close();

    try {
      const { tokens } = await oauth2.getToken(code.trim());
      oauth2.setCredentials(tokens);

      fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
      console.log(`\n✅ Token disimpan ke: ${TOKEN_PATH}`);
      console.log('Upload agent siap digunakan!');
    } catch (err) {
      console.error('❌ Gagal mendapatkan token:', err.message);
      process.exit(1);
    }
  });
}

main();
