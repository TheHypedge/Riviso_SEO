import { redirect } from "next/navigation";

/** Legacy route — auth lives at `/`. */
export default function LoginRedirectPage() {
  redirect("/");
}
