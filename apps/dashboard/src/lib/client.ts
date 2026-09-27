import { createApiClient, loginPath } from "./api.ts";

let redirecting = false;

/** Shared browser client: a 401 from any call sends the user to the login page, returning here afterwards. */
export const api = createApiClient({
  fetch: (input, init) => window.fetch(input, init),
  onUnauthorized: () => {
    if (redirecting || window.location.pathname === "/login") return;
    redirecting = true;
    window.location.replace(loginPath(`${window.location.pathname}${window.location.search}`));
  },
});
