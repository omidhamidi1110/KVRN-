import Link from 'next/link'

export default function ProjectKVRNCollectionPage() {
  return (
    <main className="min-h-screen bg-[#F9F8F6]">
      <section className="bg-[#0E0E0E] text-[#F0EDE8] pt-[calc(36px+56px+72px)] pb-20">
        <div className="container-kvrn">
          <p className="text-[11px] tracking-[0.18em] uppercase text-[#F0EDE8]/50 mb-4">Available now</p>
          <h1 className="font-display font-light text-[56px] md:text-[86px] leading-[0.9] tracking-[-0.04em]">Project<br />KVRN</h1>
        </div>
      </section>

      <section className="container-kvrn py-12 md:py-16">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          <Link href="/products/kvrn-phantom-hoodie" className="group">
            <div className="aspect-[4/5] bg-[#F2EFE9] border border-[#E8E5E0] mb-4" />
            <div className="flex justify-between text-[13px]">
              <span>Project KVRN Hoodie</span>
              <span>$80</span>
            </div>
            <p className="text-[11px] tracking-[0.14em] uppercase text-[#9B9B9B] mt-2 group-hover:text-[#1A1A1A]">View product</p>
          </Link>

          <Link href="/products/kvrn-phantom-sweatpants" className="group">
            <div className="aspect-[4/5] bg-[#F2EFE9] border border-[#E8E5E0] mb-4" />
            <div className="flex justify-between text-[13px]">
              <span>Project KVRN Sweatpants</span>
              <span>$80</span>
            </div>
            <p className="text-[11px] tracking-[0.14em] uppercase text-[#9B9B9B] mt-2 group-hover:text-[#1A1A1A]">View product</p>
          </Link>
        </div>
      </section>
    </main>
  )
}
