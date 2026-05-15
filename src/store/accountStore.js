"use strict";
/**
 * accountStore — abstração de persistência de contas.
 *
 * Hoje: JSON em disco (data/accounts.json).
 * Migração Prisma: só trocar o corpo de save/list/delete,
 * mantendo a mesma interface exportada.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.save = save;
exports.list = list;
exports.remove = remove;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const crypto_1 = require("crypto");
const DATA_DIR = path_1.default.resolve(process.cwd(), 'data');
const DATA_FILE = path_1.default.join(DATA_DIR, 'accounts.json');
function readAll() {
    try {
        if (!fs_1.default.existsSync(DATA_FILE))
            return [];
        const raw = fs_1.default.readFileSync(DATA_FILE, 'utf-8').trim();
        return raw ? JSON.parse(raw) : [];
    }
    catch {
        return [];
    }
}
function writeAll(accounts) {
    if (!fs_1.default.existsSync(DATA_DIR))
        fs_1.default.mkdirSync(DATA_DIR, { recursive: true });
    fs_1.default.writeFileSync(DATA_FILE, JSON.stringify(accounts, null, 2), 'utf-8');
}
/** Salva uma nova conta. Retorna o registro com id gerado. */
function save(data) {
    const account = {
        id: (0, crypto_1.randomUUID)(),
        createdAt: new Date().toISOString(),
        ...data,
    };
    const all = readAll();
    all.unshift(account);
    writeAll(all);
    return account;
}
/** Lista todas as contas, da mais recente para a mais antiga. */
function list() {
    return readAll();
}
/** Remove uma conta pelo id. */
function remove(id) {
    const all = readAll();
    const next = all.filter((a) => a.id !== id);
    if (next.length === all.length)
        return false;
    writeAll(next);
    return true;
}
//# sourceMappingURL=accountStore.js.map