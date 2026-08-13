export type Role = "teller" | "readonly";

export interface User {
  username: string;
  password: string;
  role: Role;
}

// Dummy dev-only credentials for a local mock app — never real, never secret.
export const USERS: User[] = [
  { username: "teller1", password: "bankdemo123", role: "teller" },
  { username: "viewer1", password: "bankdemo123", role: "readonly" },
];

export interface Member {
  id: string;
  name: string;
  savings: number;
  checking: number;
}

export const MEMBERS: Record<string, Member> = {
  "1001": { id: "1001", name: "Alicia Gomez", savings: 3482.1, checking: 940.55 },
  "1002": { id: "1002", name: "Marcus Webb", savings: 128.0, checking: 55.2 },
  "1003": { id: "1003", name: "Priya Natarajan", savings: 15200.77, checking: 2200.0 },
};

export interface SubAccount {
  accountNumber: string;
  memberId: string;
  accountType: string;
  openingDeposit: number;
  createdAt: string;
}

export const SUB_ACCOUNTS: SubAccount[] = [];

let nextAccountNumber = 90001;
export function createSubAccount(memberId: string, accountType: string, openingDeposit: number): SubAccount {
  const account: SubAccount = {
    accountNumber: String(nextAccountNumber++),
    memberId,
    accountType,
    openingDeposit,
    createdAt: new Date().toISOString(),
  };
  SUB_ACCOUNTS.push(account);
  return account;
}
