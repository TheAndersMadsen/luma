import { PasscodeView } from "./PasscodeView";
import { PasswordSection } from "./PasswordSection";

export const metadata = { title: "Humane Center" };

export default function SecurityPage() {
  return (
    <>
      <PasscodeView />
      <PasswordSection realm={process.env.KEYCLOAK_REALM ?? "humane"} />
    </>
  );
}
