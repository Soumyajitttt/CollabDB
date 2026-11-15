import { withAuth } from "next-auth/middleware";

export default withAuth({ pages: { signIn: "/login" } });

// /local (the Week 1 browser-only table) and /login stay public.
export const config = { matcher: ["/", "/doc/:path*"] };
