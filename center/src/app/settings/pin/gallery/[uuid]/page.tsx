import { redirect } from "next/navigation";

/*
 * This address named a row in the Pin's own media store, which does not
 * identify a capture in the account, so it opens the captures library.
 */
export default function Page() {
  redirect("/captures");
}
