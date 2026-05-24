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
    // expirationDate em segundos para GM_cookie; em ms para document.cookie/cookieStore
    const expires  = (c.expires && c.expires > 0) ? Math.round(c.expires) : -1;
    return `[${name},${value},${domain},${secure},${httpOnly},${expires}]`;
  });

  const cArray = `[${rows.join(',')}]`;

  const header = [
    '// ==UserScript==',
    '// @name         Socure LINK Login',
    '// @namespace    User Name',
    '// @version      5.4',
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
   * v5.4 — restaura logica exata do v3.0 que funcionava
   *
   * O v3 usava sessionStorage como flag anti-loop.
   * sessionStorage persiste durante redirects na mesma aba,
   * entao: injeta tudo → seta flag → redireciona → flag bloqueia novo redirect.
   *
   * Erros das versoes intermediarias:
   * - Usavam document.cookie.indexOf('sid=') para detectar sessao.
   *   sid eh httpOnly: NUNCA aparece em document.cookie. Sempre retornava vazio.
   *   Resultado: sempre reinjetava e redirecionava → loop infinito.
   *
   * Logica v5.4 (identica ao v3, formato de cookies atualizado):
   * 1. Injeta TODOS os cookies de uma vez (todos os dominios)
   * 2. Se ja esta em drivers.uber.com → nao faz nada
   * 3. Se flag sessionStorage ja setada → nao redireciona
   * 4. Caso contrario → seta flag → redireciona para drivers.uber.com em 800ms
   */
  const body =
    `(function(){` +
    `var H=window.location.hostname;` +
    `var C=${cArray};` +
    `var EX=Math.floor(Date.now()/1000)+31536000;` +
    `var ok=function(d){var nd=d.replace(/^[.]/,'');return H===nd||H.endsWith('.'+nd);};` +

    // injeta TODOS os cookies (mesma logica do v3)
    `C.forEach(function(c){` +
      `var n=c[0],v=c[1],d=c[2],s=c[3],h=c[4],e=c[5]>0?c[5]:EX;` +
      // GM_cookie para cookies httpOnly e nao-httpOnly
      `if(typeof GM_cookie!='undefined'){` +
        `GM_cookie.set({name:n,value:v,domain:d.replace(/^[.]/,''),path:'/',secure:!!s,httpOnly:!!h,expirationDate:e},function(){});` +
      `}` +
      // document.cookie apenas para nao-httpOnly do dominio atual
      `if(!h&&ok(d)){` +
        `try{document.cookie=n+'='+v+';path=/;domain='+d+';expires='+new Date(e*1000).toUTCString()+(s?';secure':'');}catch(x){}` +
      `}` +
    `});` +

    `console.log('[SocureLink] H=',H,'cookies injetados:',C.length);` +

    // se ja esta em drivers: nao faz nada
    `if(H==='drivers.uber.com'){console.log('[SocureLink] drivers, sem acao.');return;}` +

    // flag sessionStorage anti-loop (persiste entre redirects na mesma aba)
    `var RAN='__sl_done';` +
    `if(sessionStorage.getItem(RAN)){console.log('[SocureLink] ja redirecionou, aguardando Uber...');return;}` +
    `sessionStorage.setItem(RAN,'1');` +

    // redireciona para drivers em 800ms (igual ao v3)
    `console.log('[SocureLink] redirecionando para drivers...');` +
    `setTimeout(function(){location.href='https://drivers.uber.com/';},800);` +
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
