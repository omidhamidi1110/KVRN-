import Link from 'next/link'

export default function NotFound() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-6 text-center">
      <p className="label-11 text-kvrn-muted mb-4">404</p>
      <h1 className="font-display font-light text-[48px] md:text-[64px] leading-none tracking-tighter mb-4">
        This page
        <br />
        doesn&apos;t exist.
      </h1>
      <p className="text-[15px] text-kvrn-muted mb-10">
        It may have moved, or the link may be incorrect.
      </p>
      <Link
        href="/"
        className="text-[13px] font-light tracking-widest uppercase border border-kvrn-text px-6 h-12 inline-flex items-center hover:bg-kvrn-text hover:text-kvrn-bg transition-colors duration-150"
      >
        Back to home
      </Link>
    </div>
  )
}
