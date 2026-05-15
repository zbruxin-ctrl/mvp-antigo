/**
 * accountStore — abstração de persistência de contas.
 *
 * Hoje: JSON em disco (data/accounts.json).
 * Migração Prisma: só trocar o corpo de save/list/delete,
 * mantendo a mesma interface exportada.
 */
import { Account } from '../types/account';
/** Salva uma nova conta. Retorna o registro com id gerado. */
export declare function save(data: Omit<Account, 'id' | 'createdAt'>): Account;
/** Lista todas as contas, da mais recente para a mais antiga. */
export declare function list(): Account[];
/** Remove uma conta pelo id. */
export declare function remove(id: string): boolean;
//# sourceMappingURL=accountStore.d.ts.map