import Link from "next/link";

/** Port of app/views/home/index.html.erb. */
export default function HomePage() {
  return (
    <>
      <header className="flex justify-end p-2">
        <Link href="/login" className="text-blue-600 hover:text-orange-600">
          Sign in
        </Link>
      </header>
      <div className="flex h-screen flex-col items-center justify-center gap-2">
        <div className="rounded-lg bg-slate-900 p-4 text-4xl">💧</div>
        <p className="text-slate-600">Fluid</p>
      </div>
    </>
  );
}
