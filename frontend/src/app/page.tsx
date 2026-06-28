import { Suspense } from "react";
import AuthPage from "@/components/AuthPage";
import ResetSuccessBanner from "@/components/ResetSuccessBanner";

export default function Home() {
  return (
    <>
      <Suspense>
        <ResetSuccessBanner />
      </Suspense>
      <AuthPage />
    </>
  );
}
