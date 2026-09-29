import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

async function powershellJson(script, input) {
  if (process.platform !== 'win32') throw new Error('Windows DPAPI credential storage requires Windows.');
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // PowerShell 7 exports its Core-only module search path to Node. Windows
  // PowerShell 5.1 must load its own Security/Utility modules for DPAPI.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'PSMODULEPATH'));
  env.PSModulePath = path.join(path.dirname(executable), 'Modules');
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['-NoProfile', '-NonInteractive', '-Command', script], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Credential operation timed out.')); }, 15000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', data => { output += data; });
    child.stderr.resume(); // Never copy credentials or command internals to logs.
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error('Windows credential operation failed.'));
      try { resolve(JSON.parse(output.replace(/^\uFEFF/, ''))); }
      catch { reject(new Error('Invalid Windows credential result.')); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(input));
  });
}

export async function saveCredentials(file, registration) {
  const encrypted = await powershellJson(`
$ErrorActionPreference = 'Stop'
$credentialInput = [Console]::In.ReadToEnd() | ConvertFrom-Json
$protectedSecret = ConvertTo-SecureString -String $credentialInput.client_secret -AsPlainText -Force | ConvertFrom-SecureString
@{ appId = $credentialInput.client_id; secretDpapi = $protectedSecret; ownerOpenId = $credentialInput.user_info.open_id; brand = $credentialInput.user_info.tenant_brand } | ConvertTo-Json -Compress
`, registration);
  await writeFile(file, JSON.stringify(encrypted, null, 2) + '\n', { flag: 'wx' });
  return { appId: encrypted.appId, ownerOpenId: encrypted.ownerOpenId, brand: encrypted.brand };
}

export async function loadCredentials(file) {
  const encrypted = JSON.parse(await readFile(file, 'utf8'));
  const decoded = await powershellJson(`
$ErrorActionPreference = 'Stop'
$credentialInput = [Console]::In.ReadToEnd() | ConvertFrom-Json
$secureSecret = ConvertTo-SecureString -String $credentialInput.secretDpapi
$plainSecret = [System.Net.NetworkCredential]::new('', $secureSecret).Password
@{ appId = $credentialInput.appId; appSecret = $plainSecret; ownerOpenId = $credentialInput.ownerOpenId; brand = $credentialInput.brand } | ConvertTo-Json -Compress
`, encrypted);
  if (!decoded.appId || !decoded.appSecret) throw new Error('Invalid dedicated-bot credential file.');
  return decoded;
}

export async function checkCredentialProtection() {
  const result = await powershellJson(`
$ErrorActionPreference = 'Stop'
$offlineSecret = 'bridge-offline-credential-self-check'
$encryptedSecret = ConvertTo-SecureString -String $offlineSecret -AsPlainText -Force | ConvertFrom-SecureString
$decryptedSecret = [System.Net.NetworkCredential]::new('', (ConvertTo-SecureString -String $encryptedSecret)).Password
@{ ok = ($decryptedSecret -eq $offlineSecret) } | ConvertTo-Json -Compress
`, {});
  if (result.ok !== true) throw new Error('Credential encryption preflight did not pass.');
}
