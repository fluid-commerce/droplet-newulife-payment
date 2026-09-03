import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      permissionSets: string[];
    } & DefaultSession["user"];
  }

  interface User {
    permissionSets?: string[];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    userId?: string;
    permissionSets?: string[];
  }
}
