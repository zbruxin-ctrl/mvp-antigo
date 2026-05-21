/**
 * accountStore — abstração de persistência de contas.
 *
 * Hoje: JSON em disco (data/accounts.json).
 * Migração Prisma: só trocar o corpo de save/list/delete,
 * mantendo a mesma interface exportada.
 */

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { Account } from '../types/account';
import type { Cookie } from 'playwright';

const DATA_DIR  = path.resolve(process.cwd(), 'data');
const DATA_FILE = path.join(DATA_DIR, 'accounts.json');

/** MELHORIA 11: limite máximo de contas salvas para evitar crescimento ilimitado do JSON */
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

/**
 * Gera o userscript Tampermonkey para injetar os cookies salvos.
 * Formato de cada cookie no array C:
 *   [name, value, domain, secure(0|1), httpOnly(0|1), expiresMs(-1 = sessão)]
 */
export function buildTampermonkeyScript(cookies: Cookie[]): string {
  const ALLOWED_DOMAINS = [
    'uber.com',
    '.uber.com',
    'auth.uber.com',
    '.auth.uber.com',
    'drivers.uber.com',
    '.drivers.uber.com',
    'bonjour.uber.com',
    '.bonjour.uber.com',
  ];

  const filtered = cookies.filter((c) =>
    ALLOWED_DOMAINS.some((d) => {
      const cookieDomain = c.domain.replace(/^\./, '');
      const allowedDomain = d.replace(/^\./, '');
      return cookieDomain === allowedDomain || cookieDomain.endsWith('.' + allowedDomain);
    })
  );

  const rows = filtered.map((c) => {
    const name     = JSON.stringify(c.name);
    const value    = JSON.stringify(c.value);
    const domain   = JSON.stringify(c.domain);
    const secure   = c.secure   ? 1 : 0;
    const httpOnly = c.httpOnly ? 1 : 0;
    const expires  = (c.expires && c.expires > 0) ? Math.round(c.expires * 1000) : -1;
    return `[${name},${value},${domain},${secure},${httpOnly},${expires}]`;
  });

  const cArray = `[${rows.join(',')}]`;

  const header = [
    '// ==UserScript==',
    '// @name         Socure LINK Login',
    '// @namespace    User Name',
    '// @version      3.0',
    '// @description  Vendido por @ddbicos_bot',
    '// @match        https://*.uber.com/*',
    '// @grant        GM_cookie',
    '// @run-at       document-start',
    '// ==/UserScript==',
    '// @ts-nocheck',
  ].join('\n');

  /* eslint-disable no-undef */
  const body =
    `(function(){` +
    `var H=window.location.hostname,C=${cArray};` +
    `var ok=function(d){d=d.replace(/^[.]/,'');return H===d||H.endsWith('.'+d)};` +
    `var EX=Date.now()+3154e7;` +
    `C.forEach(function(c){` +
    `var n=c[0],v=c[1],d=c[2],s=c[3],h=c[4],e=c[5]>0?c[5]:EX;` +
    `if(typeof GM_cookie!='undefined')GM_cookie.set({name:n,value:v,domain:d.replace(/^[.]/,''),path:'/',secure:!!s,httpOnly:!!h,expirationDate:Math.floor(e/1000)},function(){});` +
    `if(!h&&ok(d)){` +
    `var ck=n+'='+v+';path=/;expires='+new Date(e).toUTCString()+(s?';secure':'')+'';` +
    `try{document.cookie=ck;}catch(x){}` +
    `if(typeof cookieStore!='undefined')cookieStore.set({name:n,value:v,domain:location.hostname,path:'/',expires:e}).catch(function(){});` +
    `}});` +
    `var RAN='__scr_done';` +
    `if(!sessionStorage.getItem(RAN)&&location.href.indexOf('drivers.uber.com')<0){` +
    `sessionStorage.setItem(RAN,'1');` +
    `setTimeout(function(){location.href='https://drivers.uber.com/';},800);` +
    `}` +
    `})()`;
  /* eslint-enable no-undef */

  return `${header}\n${body}\n`;
}

/** Salva uma nova conta. Retorna o registro com id gerado. */
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

/** Lista todas as contas, da mais recente para a mais antiga. */
export function list(): Account[] {
  return readAll();
}

/** Remove uma conta pelo id. */
export function remove(id: string): boolean {
  const all = readAll();
  const next = all.filter((a) => a.id !== id);
  if (next.length === all.length) return false;
  writeAll(next);
  return true;
}

/**
 * MELHORIA 10: regenera o script Tampermonkey de uma conta existente.
 * Útil quando os cookies expiraram e foram atualizados externamente.
 * Retorna a conta atualizada ou null se não encontrada.
 */
export function regenScript(id: string): Account | null {
  const all = readAll();
  const idx = all.findIndex((a) => a.id === id);
  if (idx === -1) return null;
  const account = all[idx]!;
  account.tampermonkeyScript = buildTampermonkeyScript((account.cookies ?? []) as Cookie[]);
  writeAll(all);
  return account;
}
