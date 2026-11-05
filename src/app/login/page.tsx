import type { Metadata } from "next";
import { Suspense } from "react";
import { AuthPage } from "@/components/AuthPage";

export const metadata: Metadata = { title: "Sign in" };

export default function Page({ searchParams }: PageProps<"/login">) {
  return (
    <Suspense fallback={<div className="h-64 animate-pulse rounded-2xl bg-paper-deep" aria-hidden="true" />}>
      <AuthPage mode="login" searchParams={searchParams} />
    </Suspense>
  );
}
