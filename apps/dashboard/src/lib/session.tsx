import { createContext, type ReactNode, useContext } from "react";
import type { Me } from "./types.ts";

export interface Session {
  me: Me;
  /** Refetch /api/me, e.g. after spending or buying credits. */
  refresh: () => void;
}

const SessionContext = createContext<Session | null>(null);

export function SessionProvider({ value, children }: { value: Session; children: ReactNode }) {
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error("useSession must be used inside the signed-in app shell");
  return session;
}
