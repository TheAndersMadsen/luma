"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { SessionIdentityContext, type SessionIdentity } from "./SessionReconnect";
import { AssistantProvider } from "./FloatingAssistant";

export function Providers({ assistant, identity = null, children }: { assistant: boolean; identity?: SessionIdentity | null; children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: 1,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );
  return (
    <QueryClientProvider client={client}>
      <SessionIdentityContext.Provider value={identity}>
        <AssistantProvider enabled={assistant}>{children}</AssistantProvider>
      </SessionIdentityContext.Provider>
    </QueryClientProvider>
  );
}
