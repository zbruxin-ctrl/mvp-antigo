/**
 * accountStore — abstração de persistência de contas.
 */

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { Account } from '../types/account';
import type { Cookie } from 'playwright';

const DATA_DIR  = path.resolve(process.cwd(), 'data');
const DATA_FILE = path.join(DATA_DIR, 'accounts.json');

const MAX_ACCOUNTS = 200;

function readAll(): Account[] {
  try {
    if (!fs.existsSync(DATA_FILE)) return [];
    const raw = fs.readFileSync(DATA_FILE, 'utf-8').trim();
    return raw ? (JSON.parse(raw) as Account[]) : [];
  } catch {
    return [];
  }
}

function writeAll(accounts: Account[]): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(accounts, null, 2), 'utf-8');
}

export function buildTampermonkeyScript(cookies: Cookie[]): string {
  const ALLOWED_DOMAINS = [
    'uber.com', '.uber.com',
    'auth.uber.com', '.auth.uber.com',
    'drivers.uber.com', '.drivers.uber.com',
    'bonjour.uber.com', '.bonjour.uber.com',
  ];

  const filtered = cookies.filter((c) =>
    ALLOWED_DOMAINS.some((d) => {
      const cd = c.domain.replace(/^\./, '');
      const ad = d.replace(/^\./, '');
      return cd === ad || cd.endsWith('.' + ad);
    })
  );

  const rows = filtered.map((c) => {
    const name     = JSON.stringify(c.name);
    const value    = JSON.stringify(c.value);
    const domain   = JSON.stringify(c.domain);
    const secure   = c.secure   ? 1 : 0;
    const httpOnly = c.httpOnly ? 1 : 0;
    const expires  = (c.expires && c.expires > 0) ? Math.round(c.expires) : -1;
    return `[${name},${value},${domain},${secure},${httpOnly},${expires}]`;
  });

  const sidCookie = filtered.find((c) => c.name === 'sid' && c.domain.replace(/^\./, '') === 'uber.com');
  const sidFingerprint = sidCookie ? JSON.stringify(sidCookie.value.slice(0, 20)) : '""';

  const cArray = `[${rows.join(',')}]`;

  const header = [
    '// ==UserScript==',
    '// @name         Socure LINK Login',
    '// @namespace    User Name',
    '// @version      5.0',
    '// @description  Vendido por @ddbicos_bot',
    '// @match        https://uber.com/*',
    '// @match        https://*.uber.com/*',
    '// @match        https://auth.uber.com/*',
    '// @match        https://drivers.uber.com/*',
    '// @match        https://bonjour.uber.com/*',
    '// @grant        GM_cookie',
    '// @run-at       document-start',
    '// ==/UserScript==',
  ].join('\n');

  /*
   * Fluxo v5.0:
   *
   * [auth.uber.com]
   *   sid desta conta presente  → não faz nada (Uber age sozinho)
   *   sid ausente / outra conta → injeta cookies → location.replace(drivers/?sl=1)
   *
   * [drivers.uber.com?sl=1]  ─ "fase de injecção"
   *   Seta todos os cookies via GM_cookie
   *   Ao terminar → location.replace(drivers.uber.com)  ← RELOAD REAL
   *   Isso força o Uber a ler os cookies reciém-setados (httpOnly inclusos)
   *
   * [drivers.uber.com] sem ?sl=1  ─ "fase normal"
   *   Uber já tem os cookies → não faz nada
   *   Se o Uber redirecionar para auth neste momento, é problema de sessão
   *   inválida no servidor (cookies expirados/revogados), não do script.
   */
  const body =
    `(function(){` +
    `var H=window.location.hostname;` +
    `var P=window.location.search;` +
    `var C=${cArray};` +
    `var SID_FP=${sidFingerprint};` +
    `var EX=Math.floor(Date.now()/1000)+31536000;` +
    `var ok=function(d){var nd=d.replace(/^[.]/,'');return H===nd||H.endsWith('.'+nd);};` +
    `var setCk=function(c,cb){` +
      `var n=c[0],v=c[1],d=c[2],s=c[3],h=c[4],e=c[5]>0?c[5]:EX;` +
      `if(!h){try{document.cookie=n+'='+v+';path=/;domain='+d+';expires='+new Date(e*1000).toUTCString()+(s?';secure':'');}catch(x){}}` +
      `if(typeof GM_cookie!='undefined'){GM_cookie.set({name:n,value:v,domain:d,path:'/',secure:!!s,httpOnly:!!h,expirationDate:e},cb||function(){});}` +
      `else if(cb){cb();}` +
    `};` +
    `var rel=C.filter(function(c){return ok(c[2]);});` +
    `console.log('[SocureLink] H=',H,'rel:',rel.length,'P=',P);` +

    // ── drivers.uber.com?sl=1: fase de injecção ──
    // Seta todos os cookies e depois faz reload real para drivers limpo
    `if(H==='drivers.uber.com'&&P.indexOf('sl=1')!==-1){` +
      `var tot=rel.length,cnt=0;` +
      `var done=function(){` +
        `console.log('[SocureLink] drivers: '+cnt+'/'+tot+' cookies setados — recarregando...');` +
        `location.replace('https://drivers.uber.com/');` +
      `};` +
      `if(!tot){done();return;}` +
      `rel.forEach(function(c){setCk(c,function(){cnt++;if(cnt>=tot){done();}});});` +
      `return;` +
    `}` +

    // ── drivers.uber.com sem ?sl=1: Uber age normalmente ──
    `if(H==='drivers.uber.com'){console.log('[SocureLink] drivers normal, sem acao.');return;}` +

    // ── auth.uber.com ──
    `if(H==='auth.uber.com'){` +
      `var browserSid='';` +
      `try{var m=document.cookie.match(/(?:^|;\\s*)sid=([^;]*)/);if(m)browserSid=decodeURIComponent(m[1]).slice(0,20);}catch(x){}` +
      // sid desta conta já presente → não interfere, deixa Uber agir
      `if(SID_FP&&browserSid===SID_FP){` +
        `console.log('[SocureLink] auth: sid ok, aguardando Uber...');` +
        `return;` +
      `}` +
      // sid ausente ou de outra conta → injeta cookies e vai para fase de injecção
      `var tot1=rel.length,c1=0,f1=false;` +
      `var go1=function(){if(f1)return;f1=true;console.log('[SocureLink] auth→drivers/?sl=1 ('+c1+'/'+tot1+')');location.replace('https://drivers.uber.com/?sl=1');};` +
      `var t1=setTimeout(go1,2500);` +
      `if(!tot1){clearTimeout(t1);go1();return;}` +
      `rel.forEach(function(c){setCk(c,function(){c1++;if(c1>=tot1){clearTimeout(t1);go1();}});});` +
      `return;` +
    `}` +

    // ── qualquer outro domínio uber (bonjour etc) ──
    `var tot2=rel.length,c2=0,f2=false;` +
    `var go2=function(){if(f2)return;f2=true;console.log('[SocureLink]→auth('+c2+'/'+tot2+')');location.replace('https://auth.uber.com/');};` +
    `var t2=setTimeout(go2,2500);` +
    `if(!tot2){clearTimeout(t2);go2();return;}` +
    `rel.forEach(function(c){setCk(c,function(){c2++;if(c2>=tot2){clearTimeout(t2);go2();}});});` +
    `})();`;

    return `${header}\n${body}\n`;
}

export function save(data: Omit<Account, 'id' | 'createdAt'>): Account {
  const account: Account = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    ...data,
    tampermonkeyScript: buildTampermonkeyScript(data.cookies as Cookie[]),
  };
  const all = readAll();
  all.unshift(account);
  writeAll(all.slice(0, MAX_ACCOUNTS));
  return account;
}

export function list(): Account[] {
  return readAll();
}

export function remove(id: string): boolean {
  const all = readAll();
  const next = all.filter((a) => a.id !== id);
  if (next.length === all.length) return false;
  writeAll(next);
  return true;
}

export function regenScript(id: string): Account | null {
  const all = readAll();
  const idx = all.findIndex((a) => a.id === id);
  if (idx === -1) return null;
  const account = all[idx]!;
  account.tampermonkeyScript = buildTampermonkeyScript((account.cookies ?? []) as Cookie[]);
  writeAll(all);
  return account;
}
