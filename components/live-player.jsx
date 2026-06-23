"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import Hls from "hls.js"
import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  Volume1,
  Subtitles,
  Settings,
  Cast,
  Maximize,
  Minimize,
} from "lucide-react"

const STREAM_URL =
  "https://59nyqw82ywap-hls-live.5centscdn.com/heal/fe5d9b5f983240121078dd5588b66c42.sdp/playlist.m3u8"

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00"
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
  }
  return `${m}:${String(s).padStart(2, "0")}`
}

export default function LivePlayer() {
  const videoRef = useRef(null)
  const containerRef = useRef(null)
  const hlsRef = useRef(null)
  const hideTimerRef = useRef(null)

  const [status, setStatus] = useState("loading") // loading | playing | offline
  const [isPlaying, setIsPlaying] = useState(false)
  const [isMuted, setIsMuted] = useState(true)
  const [volume, setVolume] = useState(1)
  const [controlsVisible, setControlsVisible] = useState(true)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [showCaptions, setShowCaptions] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [levels, setLevels] = useState([])
  const [currentLevel, setCurrentLevel] = useState(-1)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [seekable, setSeekable] = useState(0)
  const [seekableStart, setSeekableStart] = useState(0)
  const [isLive, setIsLive] = useState(true)
  const [showLiveToast, setShowLiveToast] = useState(false)
  const toastTimerRef = useRef(null)

  // ---- Setup HLS ----
  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    let destroyed = false

    const handlePlaying = () => {
      if (destroyed) return
      setStatus("playing")
      setIsPlaying(true)
    }
    const handlePause = () => setIsPlaying(false)
    const handlePlay = () => setIsPlaying(true)
    const handleWaiting = () => { }
    const handleError = () => {
      if (destroyed) return
      setStatus("offline")
    }
    const handleVolume = () => {
      setIsMuted(video.muted || video.volume === 0)
      setVolume(video.volume)
    }

    // Continuously evaluate position relative to the live edge.
    const syncLiveState = () => {
      if (destroyed) return
      setCurrentTime(video.currentTime)
      if (video.seekable && video.seekable.length > 0) {
        const end = video.seekable.end(video.seekable.length - 1)
        const start = video.seekable.start(0)
        setSeekable(end)
        setSeekableStart(start)
        // Live when within the 3s threshold of the seekable end (and not paused).
        const behind = end - video.currentTime
        setIsLive(!video.paused && behind <= 3)
      }
      if (Number.isFinite(video.duration)) setDuration(video.duration)
    }

    video.addEventListener("loadedmetadata", syncLiveState)
    video.addEventListener("playing", handlePlaying)
    video.addEventListener("playing", syncLiveState)
    video.addEventListener("play", handlePlay)
    video.addEventListener("pause", handlePause)
    video.addEventListener("pause", syncLiveState)
    video.addEventListener("waiting", handleWaiting)
    video.addEventListener("waiting", syncLiveState)
    video.addEventListener("volumechange", handleVolume)
    video.addEventListener("timeupdate", syncLiveState)
    video.addEventListener("progress", syncLiveState)
    video.addEventListener("seeking", syncLiveState)
    video.addEventListener("seeked", syncLiveState)

    if (Hls.isSupported()) {
      const hls = new Hls({
        lowLatencyMode: true,
        liveSyncDurationCount: 3,
        enableWorker: true,
        backBufferLength: 90,
      })
      hlsRef.current = hls
      hls.loadSource(STREAM_URL)
      hls.attachMedia(video)

      hls.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
        if (destroyed) return
        setLevels(data.levels || [])
        video.muted = true
        const p = video.play()
        if (p && p.catch) p.catch(() => { })
      })
      hls.on(Hls.Events.LEVEL_SWITCHED, (_e, data) => {
        setCurrentLevel(data.level)
      })
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (!data.fatal) return
        switch (data.type) {
          case Hls.ErrorTypes.NETWORK_ERROR:
            hls.startLoad()
            break
          case Hls.ErrorTypes.MEDIA_ERROR:
            hls.recoverMediaError()
            break
          default:
            if (!destroyed) setStatus("offline")
            break
        }
      })
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      // Native HLS (Safari / iOS)
      video.src = STREAM_URL
      video.muted = true
      video.addEventListener("loadedmetadata", () => {
        const p = video.play()
        if (p && p.catch) p.catch(() => { })
      })
      video.addEventListener("error", handleError)
    } else {
      setStatus("offline")
    }

    return () => {
      destroyed = true
      video.removeEventListener("loadedmetadata", syncLiveState)
      video.removeEventListener("playing", handlePlaying)
      video.removeEventListener("playing", syncLiveState)
      video.removeEventListener("play", handlePlay)
      video.removeEventListener("pause", handlePause)
      video.removeEventListener("pause", syncLiveState)
      video.removeEventListener("waiting", handleWaiting)
      video.removeEventListener("waiting", syncLiveState)
      video.removeEventListener("volumechange", handleVolume)
      video.removeEventListener("timeupdate", syncLiveState)
      video.removeEventListener("progress", syncLiveState)
      video.removeEventListener("seeking", syncLiveState)
      video.removeEventListener("seeked", syncLiveState)
      if (hlsRef.current) {
        hlsRef.current.destroy()
        hlsRef.current = null
      }
    }
  }, [])

  // ---- Fullscreen tracking ----
  useEffect(() => {
    const onFsChange = () => setIsFullscreen(Boolean(document.fullscreenElement))
    document.addEventListener("fullscreenchange", onFsChange)
    return () => document.removeEventListener("fullscreenchange", onFsChange)
  }, [])

  // ---- Auto-hide controls ----
  const revealControls = useCallback(() => {
    setControlsVisible(true)
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
    hideTimerRef.current = setTimeout(() => {
      setControlsVisible(false)
      setShowSettings(false)
    }, 3000)
  }, [])

  useEffect(() => {
    revealControls()
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
    }
  }, [revealControls])

  // ---- Actions ----
  const togglePlay = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    if (video.paused) {
      const p = video.play()
      if (p && p.catch) p.catch(() => { })
    } else {
      video.pause()
    }
  }, [])

  const goLive = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    if (video.seekable && video.seekable.length > 0) {
      const liveEdge = video.seekable.end(video.seekable.length - 1)
      video.currentTime = liveEdge
    }
    if (video.paused) {
      const p = video.play()
      if (p && p.catch) p.catch(() => { })
    }
    setIsLive(true)
    setShowLiveToast(true)
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    toastTimerRef.current = setTimeout(() => setShowLiveToast(false), 2500)
  }, [])

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    }
  }, [])

  const toggleMute = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    video.muted = !video.muted
    if (!video.muted && video.volume === 0) {
      video.volume = 1
    }
  }, [])

  const handleVolumeChange = useCallback((e) => {
    const video = videoRef.current
    if (!video) return
    const v = Number(e.target.value)
    video.volume = v
    video.muted = v === 0
  }, [])

  const toggleFullscreen = useCallback(() => {
    const el = containerRef.current
    const video = videoRef.current
    const doc = document

    const fsElement = doc.fullscreenElement || doc.webkitFullscreenElement

    try {
      if (fsElement) {
        const exit = doc.exitFullscreen || doc.webkitExitFullscreen
        const result = exit?.call(doc)
        if (result && result.catch) result.catch(() => {})
        return
      }

      // Prefer fullscreen on the container so overlays/controls remain visible.
      const request = el && (el.requestFullscreen || el.webkitRequestFullscreen)
      if (request) {
        const result = request.call(el)
        if (result && result.catch) {
          // If the iframe disallows the Fullscreen API, fall back to the
          // native video fullscreen (e.g. iOS Safari) without throwing.
          result.catch(() => {
            video?.webkitEnterFullscreen?.()
          })
        }
        return
      }

      // No element-level fullscreen available: try native video fullscreen.
      video?.webkitEnterFullscreen?.()
    } catch {
      // Fullscreen is blocked by permissions policy (common inside iframes).
      // Fail silently and attempt the native video fallback.
      try {
        video?.webkitEnterFullscreen?.()
      } catch {
        /* no-op */
      }
    }
  }, [])

  const toggleCaptions = useCallback(() => {
    const video = videoRef.current
    setShowCaptions((prev) => {
      const next = !prev
      if (video && video.textTracks) {
        for (let i = 0; i < video.textTracks.length; i++) {
          video.textTracks[i].mode = next ? "showing" : "hidden"
        }
      }
      return next
    })
  }, [])

  const handleCast = useCallback(() => {
    const video = videoRef.current
    if (video && typeof video.requestPictureInPicture === "function") {
      if (document.pictureInPictureElement) {
        document.exitPictureInPicture?.()
      } else {
        video.requestPictureInPicture().catch(() => { })
      }
    }
  }, [])

  const selectLevel = useCallback((level) => {
    if (hlsRef.current) {
      hlsRef.current.currentLevel = level
      setCurrentLevel(level)
    }
    setShowSettings(false)
  }, [])

  // ---- Keyboard shortcuts ----
  useEffect(() => {
    const onKey = (e) => {
      const video = videoRef.current
      if (!video) return
      switch (e.key) {
        case " ":
        case "Spacebar":
          e.preventDefault()
          togglePlay()
          break
        case "f":
        case "F":
          e.preventDefault()
          toggleFullscreen()
          break
        case "m":
        case "M":
          e.preventDefault()
          toggleMute()
          break
        case "l":
        case "L":
          e.preventDefault()
          goLive()
          break
        case "ArrowLeft":
          e.preventDefault()
          video.currentTime = Math.max(0, video.currentTime - 10)
          break
        case "ArrowRight":
          e.preventDefault()
          video.currentTime = video.currentTime + 10
          break
        default:
          break
      }
      revealControls()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [togglePlay, toggleFullscreen, toggleMute, goLive, revealControls])

  const isOffline = status === "offline"
  const isLoading = status === "loading"

  const VolumeIcon = isMuted || volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2

  // How far behind the live edge the viewer currently is (seconds).
  const behindSeconds = Math.max(0, seekable - currentTime)
  const showGoLive = !isLive && behindSeconds > 3
  const behindLabel = (() => {
    const s = Math.round(behindSeconds)
    if (s >= 60) {
      const m = Math.floor(s / 60)
      return `${m}m Behind Live`
    }
    return `${s}s Behind Live`
  })()

  // Position within the DVR window for the progress thumb.
  const dvrWindow = Math.max(1, seekable - seekableStart)
  const progressPercent = isLive
    ? 100
    : Math.min(100, Math.max(0, ((currentTime - seekableStart) / dvrWindow) * 100))

  return (
    <div
      ref={containerRef}
      onMouseMove={revealControls}
      onMouseLeave={() => !isOffline && setControlsVisible(false)}
      onDoubleClick={toggleFullscreen}
      className={`group relative aspect-video w-full overflow-hidden rounded-[24px] bg-player shadow-2xl shadow-black/60 ring-1 ring-white/5 ${controlsVisible ? "cursor-default" : "cursor-none"
        }`}
    >
      <video
        ref={videoRef}
        playsInline
        autoPlay
        muted
        className="h-full w-full bg-black object-contain"
        onClick={togglePlay}
      />

      {/* Loading screen */}
      {isLoading && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-6 bg-player animate-fade-in">
          <img
            src="/ejmi-logo.png"
            alt="Encounter Jesus Television"
            className="w-48 max-w-[55%] animate-pulse-soft"
          />
          <div className="h-10 w-10 animate-spin rounded-full border-2 border-white/15 border-t-accent-live" />
          <p className="text-sm font-medium tracking-wide text-secondary-text">
            Connecting to Live Broadcast...
          </p>
        </div>
      )}

      {/* Offline screen */}
      {isOffline && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-4 bg-player px-6 text-center animate-fade-in">
          <div className="flex items-center gap-2.5">
            <span className="relative flex h-3 w-3">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent-live opacity-75" />
              <span className="relative inline-flex h-3 w-3 rounded-full bg-accent-live" />
            </span>
            <span className="text-base font-semibold tracking-[0.2em] text-white">
              LIVE STREAM OFFLINE
            </span>
          </div>
          <p className="max-w-sm text-pretty leading-relaxed text-secondary-text">
            {"We'll be live shortly. Stay connected and God bless you."}
          </p>
        </div>
      )}

      {/* LIVE / Behind indicator (top left) */}
      {!isOffline && (
        <button
          type="button"
          onClick={goLive}
          aria-label={isLive ? "Live" : "Jump to live"}
          className={`absolute left-4 top-4 z-20 flex items-center gap-2 rounded-full px-3 py-1.5 backdrop-blur-md ring-1 transition-all duration-300 ${isLive
              ? "cursor-default bg-accent-live ring-white/10"
              : "cursor-pointer bg-black/50 ring-white/15 hover:bg-black/70"
            } ${controlsVisible || isLoading ? "opacity-100" : "opacity-0"}`}
        >
          {isLive ? (
            <>
              <span className="relative flex h-2.5 w-2.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-white opacity-75" />
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-white" />
              </span>
              <span className="text-xs font-bold tracking-widest text-white">LIVE</span>
            </>
          ) : (
            <>
              <span className="inline-flex h-2.5 w-2.5 rounded-full ring-2 ring-secondary-text" />
              <span className="text-xs font-bold tracking-wide text-secondary-text">
                {behindLabel}
              </span>
            </>
          )}
        </button>
      )}

      {/* Toast: now watching live */}
      {showLiveToast && (
        <div className="pointer-events-none absolute left-1/2 top-6 z-40 -translate-x-1/2 animate-fade-in">
          <div className="flex items-center gap-2 rounded-full bg-black/70 px-4 py-2 text-sm font-medium text-white backdrop-blur-xl ring-1 ring-white/15">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent-live opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-accent-live" />
            </span>
            {"You're now watching Live."}
          </div>
        </div>
      )}

      {/* Logo watermark (bottom right) */}
      {!isLoading && (
        <img
          src="/ejmi-logo.png"
          alt="Encounter Jesus Television logo"
          className="pointer-events-none absolute bottom-3 right-3 z-10 w-20 opacity-65 drop-shadow-lg sm:bottom-4 sm:right-6 sm:w-24 md:bottom-6 md:right-8 md:w-28"
        />
      )}

      {/* Center play overlay when paused */}
      {!isOffline && !isLoading && !isPlaying && (
        <button
          type="button"
          onClick={togglePlay}
          aria-label="Play"
          className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-black/20 animate-fade-in"
        >
          <span className="flex h-20 w-20 items-center justify-center rounded-full bg-black/50 backdrop-blur-md ring-1 ring-white/15 transition-transform duration-200 hover:scale-110">
            <Play className="ml-1 h-9 w-9 fill-white text-white" />
          </span>
          <span className="flex items-center gap-2 rounded-full bg-black/50 px-3 py-1 text-xs font-semibold tracking-widest text-white backdrop-blur-md ring-1 ring-white/10">
            <Pause className="h-3.5 w-3.5" />
            PAUSED
          </span>
        </button>
      )}

      {/* Controls */}
      {!isOffline && !isLoading && (
        <div
          className={`absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-black/80 via-black/30 to-transparent px-4 pb-3 pt-16 transition-opacity duration-300 ${controlsVisible ? "opacity-100" : "pointer-events-none opacity-0"
            }`}
        >
          {/* GO LIVE floating pill (above progress bar, bottom left) */}
          {showGoLive && (
            <div className="mb-3 flex">
              <button
                type="button"
                onClick={goLive}
                aria-label="Go to live"
                className="flex items-center gap-2 rounded-full bg-accent-live px-4 py-1.5 text-xs font-bold tracking-wider text-white shadow-xl shadow-black/40 ring-1 ring-white/20 animate-pulse-soft transition-transform duration-200 hover:scale-105"
              >
                <span className="h-2 w-2 rounded-full bg-white" />
                GO LIVE
              </button>
            </div>
          )}

          {/* Progress bar */}
          <div className="mb-2 flex items-center gap-3">
            <div className="relative h-1 flex-1 rounded-full bg-white/20">
              {/* Buffered gray area that grows after the thumb while behind live */}
              {!isLive && (
                <div
                  className="absolute inset-y-0 rounded-full bg-white/35"
                  style={{
                    left: `${progressPercent}%`,
                    right: 0,
                  }}
                />
              )}
              {/* Watched (red) portion */}
              <div
                className="absolute inset-y-0 left-0 rounded-full bg-accent-live"
                style={{ width: `${progressPercent}%` }}
              />
              {/* Thumb */}
              <div
                className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent-live shadow-md ring-2 ring-white/80"
                style={{ left: `${progressPercent}%` }}
              />
            </div>
          </div>

          <div className="flex items-center justify-between gap-2">
            {/* Bottom Left */}
            <div className="flex items-center gap-2">
              <ControlButton onClick={togglePlay} label={isPlaying ? "Pause" : "Play"}>
                {isPlaying ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5" />}
              </ControlButton>

              <div className="group/vol flex items-center">
                <ControlButton onClick={toggleMute} label={isMuted ? "Unmute" : "Mute"}>
                  <VolumeIcon className="h-5 w-5" />
                </ControlButton>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={isMuted ? 0 : volume}
                  onChange={handleVolumeChange}
                  aria-label="Volume"
                  className="volume-slider ml-1 w-0 opacity-0 transition-all duration-300 group-hover/vol:w-20 group-hover/vol:opacity-100"
                />
              </div>

              <button
                type="button"
                onClick={goLive}
                aria-label={isLive ? "Live" : "Jump to live"}
                className={`ml-1 hidden items-center gap-1.5 rounded-full px-2.5 py-1 transition-colors sm:flex ${isLive
                    ? "cursor-default bg-accent-live/15"
                    : "cursor-pointer bg-white/10 hover:bg-white/20"
                  }`}
              >
                <span
                  className={`h-2 w-2 rounded-full ${isLive ? "bg-accent-live" : "ring-2 ring-secondary-text"
                    }`}
                />
                <span
                  className={`text-xs font-bold tracking-wider ${isLive ? "text-accent-live" : "text-secondary-text"
                    }`}
                >
                  {isLive ? "LIVE" : "GO LIVE"}
                </span>
              </button>
            </div>

            {/* Bottom Center */}
            <div className="hidden items-center gap-2 text-xs tabular-nums text-secondary-text md:flex">
              <span>{formatTime(currentTime)}</span>
              <span className="text-white/30">/</span>
              <span>{formatTime(seekable || duration)}</span>
            </div>

            {/* Bottom Right */}
            <div className="relative flex items-center gap-2">
              <ControlButton
                onClick={toggleCaptions}
                label="Captions"
                active={showCaptions}
              >
                <Subtitles className="h-5 w-5" />
              </ControlButton>

              <div className="relative">
                <ControlButton
                  onClick={() => setShowSettings((s) => !s)}
                  label="Settings"
                  active={showSettings}
                >
                  <Settings className="h-5 w-5" />
                </ControlButton>

                {showSettings && (
                  <div className="absolute bottom-12 right-0 w-44 overflow-hidden rounded-xl bg-black/80 p-1.5 backdrop-blur-xl ring-1 ring-white/10 animate-fade-in">
                    <p className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-widest text-secondary-text">
                      Quality
                    </p>
                    <SettingsItem
                      active={currentLevel === -1}
                      onClick={() => selectLevel(-1)}
                    >
                      Auto
                    </SettingsItem>
                    {levels.map((lvl, i) => (
                      <SettingsItem
                        key={i}
                        active={currentLevel === i}
                        onClick={() => selectLevel(i)}
                      >
                        {lvl.height ? `${lvl.height}p` : `${Math.round(lvl.bitrate / 1000)}k`}
                      </SettingsItem>
                    ))}
                  </div>
                )}
              </div>

              <ControlButton onClick={handleCast} label="Cast / Picture in Picture">
                <Cast className="h-5 w-5" />
              </ControlButton>

              <ControlButton onClick={toggleFullscreen} label="Fullscreen">
                {isFullscreen ? (
                  <Minimize className="h-5 w-5" />
                ) : (
                  <Maximize className="h-5 w-5" />
                )}
              </ControlButton>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function ControlButton({ children, onClick, label, active }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`flex h-10 w-10 items-center justify-center rounded-full text-white ring-1 transition-all duration-200 hover:scale-105 hover:bg-white/10 ${active ? "bg-accent-live/20 ring-accent-live/40" : "bg-white/5 ring-white/10"
        }`}
    >
      {children}
    </button>
  )
}

function SettingsItem({ children, onClick, active }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-white/10 ${active ? "text-accent-live" : "text-white"
        }`}
    >
      {children}
      {active && <span className="h-1.5 w-1.5 rounded-full bg-accent-live" />}
    </button>
  )
}
