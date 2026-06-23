import LivePlayer from "@/components/live-player"

export default function Page() {
  return (
    <main className="flex min-h-dvh w-full items-center justify-center bg-background p-2 sm:p-4">
      <div className="w-full max-w-[1600px] md:w-[96%] lg:w-[90%]">
        <LivePlayer />
      </div>
    </main>
  )
}
