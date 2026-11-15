import bcrypt from "bcryptjs";

// Compared against when the email is unknown, so "no such user" and "wrong password" take the same time.
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", 10);

export const hashPassword = (pw: string, cost: number) => bcrypt.hash(pw, cost);

export async function checkPassword(pw: string, hash: string | undefined): Promise<boolean> {
  const ok = await bcrypt.compare(pw, hash ?? DUMMY_HASH);
  return hash !== undefined && ok;
}
