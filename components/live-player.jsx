"use client"

import { useCallback, useEffect, useRef, useState, useMemo } from "react"
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
  // REPLACED: improved refs and state for stability, captions and cast
  const videoRef = useRef(null)
  const containerRef = useRef(null)
  const hlsRef = useRef(null)
  const hideTimerRef = useRef(null)
  const toastTimerRef = useRef(null)

  // reconnect/backoff refs
  const reconnectAttemptRef = useRef(0)
  const reconnectTimerRef = useRef(null)
  const manifestAbortRef = useRef(null)

  // UI / playback state
  const [status, setStatus] = useState("loading") // loading | playing | offline | error
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

  // subtitle tracks discovered (HLS or native)
  // Each track: { id, name, lang, url, default, hlsIndex }
  const [subtitleTracks, setSubtitleTracks] = useState([])
  // Selected subtitle id/lang: "off" | "auto" | trackId/lang
  const [selectedSubtitle, setSelectedSubtitle] = useState("off")

  // Cast availability/connection state
  const castSessionRef = useRef(null)
  const [castAvailable, setCastAvailable] = useState(false)
  const [castConnected, setCastConnected] = useState(false)
  const [castLabel, setCastLabel] = useState("Cast")

  // helper: exponential backoff delay
  const backoffDelay = useCallback((attempt, base = 1000, max = 30000) =>
    Math.min(max, Math.round(base * Math.pow(2, attempt))), [])

  // ---- Setup HLS (REPLACED useEffect) ----
  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    let destroyed = false

    const safeSetStatus = (s) => {
      if (destroyed) return
      setStatus(s)
    }

    const resetReconnect = () => {
      reconnectAttemptRef.current = 0
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = null
      }
    }

    // Sync live state (seekable/currentTime/duration)
    const syncLiveState = () => {
      if (destroyed) return
      try {
        setCurrentTime(video.currentTime || 0)
        if (video.seekable && video.seekable.length > 0) {
          const end = video.seekable.end(video.seekable.length - 1)
          const start = video.seekable.start(0)
          setSeekable(end)
          setSeekableStart(start)
          const behind = Math.max(0, end - video.currentTime)
          // Consider live if within 3s of edge and not paused
          setIsLive(!video.paused && behind <= 3)
        }
        if (Number.isFinite(video.duration)) setDuration(video.duration)
      } catch {
        // ignore transient errors reading seekable
      }
    }

    // Volume handler
    const handleVolume = () => {
      setIsMuted(video.muted || video.volume === 0)
      setVolume(video.volume)
    }

    // Playback handlers
    const handlePlaying = () => {
      if (destroyed) return
      safeSetStatus("playing")
      setIsPlaying(true)
      resetReconnect()
    }
    const handlePause = () => setIsPlaying(false)
    const handlePlay = () => setIsPlaying(true)
    const handleWaiting = () => {
      // Buffering state: keep playing flag but show loading UI
      safeSetStatus("loading")
    }
    const handleError = () => {
      if (destroyed) return
      safeSetStatus("offline")
    }

    // Attach DOM listeners
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
    video.addEventListener("error", handleError)

    // Detect native WebVTT <track> additions (e.g., Safari or manifest-injected)
    const trackObserver = new MutationObserver(() => {
      if (!video) return
      const tks = []
      if (video.textTracks && video.textTracks.length > 0) {
        for (let i = 0; i < video.textTracks.length; i++) {
          const tt = video.textTracks[i]
          tks.push({
            id: tt.id || `native-${i}`,
            name: tt.label || tt.language || `Track ${i + 1}`,
            lang: tt.language || "",
            url: tt.src || "",
            default: tt.mode === "showing",
            hlsIndex: undefined,
            nativeIndex: i,
          })
        }
      }
      if (tks.length > 0) {
        setSubtitleTracks((prev) => {
          const map = new Map(prev.map((p) => [p.id || p.url, p]))
          tks.forEach((t) => map.set(t.id || t.url, t))
          return Array.from(map.values())
        })
      }
    })
    try {
      trackObserver.observe(video, { childList: true, subtree: true })
    } catch {
      // ignore if observe fails
    }

    // HLS setup
    if (Hls.isSupported()) {
      const hls = new Hls({
        autoStartLoad: true,
        lowLatencyMode: true,
        liveSyncDurationCount: 3,
        backBufferLength: 90,
        capLevelToPlayerSize: true,
        enableWorker: true,
        maxBufferLength: 120,
      })
      hlsRef.current = hls

      // Manifest parsed: levels available
      hls.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
        if (destroyed) return
        setLevels(data.levels || [])
        try {
          video.muted = true
          const p = video.play()
          if (p && p.catch) p.catch(() => {})
        } catch {}
        safeSetStatus("playing")
      })

      // Level switched
      hls.on(Hls.Events.LEVEL_SWITCHED, (_e, data) => {
        if (destroyed) return
        setCurrentLevel(data.level)
      })

      // Subtitle tracks updated (HLS in-manifest subtitles)
      hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, (_e, data) => {
        if (destroyed) return
        const tracks = (data?.subtitleTracks || []).map((t, i) => ({
          id: t.id ?? `hls-${i}`,
          name: t.name || t.lang || t.label || `Subtitle ${i + 1}`,
          lang: t.lang || "",
          url: t.url || "",
          default: !!t.default,
          hlsIndex: i,
        }))
        setSubtitleTracks((prev) => {
          const map = new Map(prev.map((p) => [p.id || p.url, p]))
          tracks.forEach((t) => map.set(t.id || t.url, t))
          return Array.from(map.values())
        })
      })

      // Subtitle track switch event: keep selectedSubtitle in sync
      hls.on(Hls.Events.SUBTITLE_TRACK_SWITCH, (_e, data) => {
        if (destroyed) return
        const idx = data.id
        const t = hls.subtitleTracks?.[idx]
        if (t) {
          const id = t.id ?? `hls-${idx}`
          setSelectedSubtitle(id)
        }
      })

      // Error handling with recovery and exponential backoff
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (destroyed) return
        if (!data) return
        if (!data.fatal) return
        switch (data.type) {
          case Hls.ErrorTypes.NETWORK_ERROR: {
            reconnectAttemptRef.current = Math.min(8, reconnectAttemptRef.current + 1)
            const delay = backoffDelay(reconnectAttemptRef.current)
            safeSetStatus("loading")
            if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current)
            reconnectTimerRef.current = setTimeout(() => {
              try {
                hls.startLoad()
              } catch {
                safeSetStatus("offline")
              }
            }, delay)
            break
          }
          case Hls.ErrorTypes.MEDIA_ERROR: {
            try {
              hls.recoverMediaError()
            } catch {
              safeSetStatus("offline")
            }
            break
          }
          default:
            safeSetStatus("offline")
            break
        }
      })

      // Attach and load
      try {
        hls.loadSource(STREAM_URL)
        hls.attachMedia(video)
      } catch {
        if (video.canPlayType("application/vnd.apple.mpegurl")) {
          video.src = STREAM_URL
        } else {
          safeSetStatus("offline")
        }
      }
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      // Native HLS (Safari / iOS)
      const attachNativeTracksFromManifest = async (manifestUrl) => {
        try {
          if (manifestAbortRef.current) manifestAbortRef.current.abort()
          const controller = new AbortController()
          manifestAbortRef.current = controller
          const res = await fetch(manifestUrl, { signal: controller.signal, cache: "no-store" })
          if (!res.ok) return
          const text = await res.text()
          if (!text) return
          const lines = text.split(/\r?\n/)
          const mediaLines = lines.filter((l) => l.startsWith("#EXT-X-MEDIA"))
          const parsed = []
          mediaLines.forEach((line, idx) => {
            const attrs = {}
            line.replace(/^#EXT-X-MEDIA:/, "").split(",").forEach((kv) => {
              const [k, v] = kv.split("=")
              if (!k) return
              attrs[k.trim()] = v ? v.trim().replace(/^"|"$/g, "") : ""
            })
            if (attrs.TYPE === "SUBTITLES" && attrs.URI) {
              parsed.push({
                id: `manifest-${idx}`,
                name: attrs.NAME || attrs.LANGUAGE || attrs.URI,
                lang: attrs.LANGUAGE || "",
                url: new URL(attrs.URI, manifestUrl).toString(),
                default: attrs.DEFAULT === "YES",
              })
            }
          })
          if (parsed.length > 0) {
            parsed.forEach((t) => {
              const exists = Array.from(video.querySelectorAll("track")).some(
                (tr) => tr.src === t.url || tr.srclang === t.lang
              )
              if (!exists) {
                const track = document.createElement("track")
                track.kind = "subtitles"
                track.label = t.name
                track.srclang = t.lang || ""
                track.src = t.url
                track.default = !!t.default
                track.mode = "hidden"
                video.appendChild(track)
              }
            })
            setSubtitleTracks((prev) => {
              const map = new Map(prev.map((p) => [p.id || p.url, p]))
              parsed.forEach((p) => map.set(p.id || p.url, p))
              return Array.from(map.values())
            })
          }
        } catch {
          // ignore manifest fetch errors
        } finally {
          manifestAbortRef.current = null
        }
      }

      try {
        video.src = STREAM_URL
        video.muted = true
        attachNativeTracksFromManifest(STREAM_URL).catch(() => {})
        const p = video.play()
        if (p && p.catch) p.catch(() => {})
        safeSetStatus("playing")
      } catch {
        safeSetStatus("offline")
      }
    } else {
      safeSetStatus("offline")
    }

    // Cleanup on unmount
    return () => {
      destroyed = true
      try {
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
        video.removeEventListener("error", handleError)
      } catch {}

      if (hlsRef.current) {
        try {
          hlsRef.current.destroy()
        } catch {}
        hlsRef.current = null
      }

      if (manifestAbortRef.current) {
        try {
          manifestAbortRef.current.abort()
        } catch {}
        manifestAbortRef.current = null
      }

      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = null
      }

      try {
        trackObserver.disconnect()
      } catch {}
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---- Fullscreen tracking (REPLACED useEffect) ----
  useEffect(() => {
    const onFsChange = () => {
      const fsEl = document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement
      setIsFullscreen(Boolean(fsEl))
    }
    document.addEventListener("fullscreenchange", onFsChange)
    document.addEventListener("webkitfullscreenchange", onFsChange)
    document.addEventListener("mozfullscreenchange", onFsChange)
    document.addEventListener("MSFullscreenChange", onFsChange)
    return () => {
      document.removeEventListener("fullscreenchange", onFsChange)
      document.removeEventListener("webkitfullscreenchange", onFsChange)
      document.removeEventListener("mozfullscreenchange", onFsChange)
      document.removeEventListener("MSFullscreenChange", onFsChange)
    }
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
      try {
        const liveEdge = video.seekable.end(video.seekable.length - 1)
        video.currentTime = liveEdge
      } catch {
        // ignore
      }
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
    // update state
    setIsMuted(video.muted)
    setVolume(video.volume)
  }, [])

  const handleVolumeChange = useCallback((e) => {
    const video = videoRef.current
    if (!video) return
    const v = Number(e.target.value)
    video.volume = v
    video.muted = v === 0
    setVolume(v)
    setIsMuted(video.muted)
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

  // ---- Captions (REPLACED toggleCaptions) ----
  const toggleCaptions = useCallback(() => {
    const video = videoRef.current
    if (!video) return

    // If no subtitle tracks discovered, disable toggle and show tooltip (UI handles tooltip)
    if (!subtitleTracks || subtitleTracks.length === 0) {
      setShowCaptions(false)
      setSelectedSubtitle("off")
      return
    }

    setShowCaptions((prev) => {
      const next = !prev

      if (hlsRef.current) {
        try {
          if (!next) {
            hlsRef.current.subtitleTrack = -1
            setSelectedSubtitle("off")
          } else {
            const defIdx = subtitleTracks.findIndex((t) => t.default)
            const idx = defIdx >= 0 ? subtitleTracks[defIdx].hlsIndex : subtitleTracks[0].hlsIndex
            if (typeof idx === "number") {
              hlsRef.current.subtitleTrack = idx
              setSelectedSubtitle(subtitleTracks.find((t) => t.hlsIndex === idx)?.id || "auto")
            } else {
              if (video.textTracks && video.textTracks.length > 0) {
                for (let i = 0; i < video.textTracks.length; i++) {
                  video.textTracks[i].mode = next ? "showing" : "hidden"
                }
                setSelectedSubtitle(next ? "auto" : "off")
              }
            }
          }
        } catch {
          if (video.textTracks && video.textTracks.length > 0) {
            for (let i = 0; i < video.textTracks.length; i++) {
              video.textTracks[i].mode = next ? "showing" : "hidden"
            }
            setSelectedSubtitle(next ? "auto" : "off")
          }
        }
      } else {
        if (video.textTracks && video.textTracks.length > 0) {
          for (let i = 0; i < video.textTracks.length; i++) {
            video.textTracks[i].mode = next ? "showing" : "hidden"
          }
          setSelectedSubtitle(next ? "auto" : "off")
        } else {
          setSelectedSubtitle("off")
        }
      }

      return next
    })
  }, [subtitleTracks])

  // ---- Cast (REPLACED handleCast) ----
  const handleCast = useCallback(async () => {
    const video = videoRef.current
    if (!video) return

    // 1) Chromecast (if SDK present)
    try {
      if (typeof window !== "undefined" && window.chrome && window.chrome.cast) {
        const castApi = window.chrome.cast
        try {
          const sessionRequest = new castApi.SessionRequest(castApi.media.DEFAULT_MEDIA_RECEIVER_APP_ID)
          const apiConfig = new castApi.ApiConfig(sessionRequest,
            (session) => {
              castSessionRef.current = session
              setCastConnected(Boolean(session))
              setCastLabel(session?.receiver?.friendlyName || "Chromecast")
            },
            (receiver) => {}
          )
          castApi.initialize(apiConfig, () => {
            castApi.requestSession((session) => {
              castSessionRef.current = session
              setCastConnected(true)
              setCastLabel(session?.receiver?.friendlyName || "Chromecast")
              try {
                const mediaInfo = new castApi.media.MediaInfo(STREAM_URL, "application/x-mpegurl")
                const request = new castApi.media.LoadRequest(mediaInfo)
                session.loadMedia(request, () => {}, () => {})
              } catch {}
            }, () => {})
          }, () => {})
          return
        } catch {
          // fallthrough
        }
      }
    } catch {
      // ignore
    }

    // 2) Remote Playback API
    try {
      if ("remote" in HTMLMediaElement.prototype && video.remote) {
        await video.remote.prompt()
        setCastConnected(true)
        setCastLabel("Remote Device")
        return
      }
    } catch {
      // fallback
    }

    // 3) Apple AirPlay (webkitShowPlaybackTargetPicker)
    try {
      if (typeof video.webkitShowPlaybackTargetPicker === "function") {
        try {
          video.webkitShowPlaybackTargetPicker()
          setCastConnected(true)
          setCastLabel("AirPlay")
          return
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }

    // 4) Picture-in-Picture fallback
    try {
      if (document.pictureInPictureEnabled && typeof video.requestPictureInPicture === "function") {
        if (document.pictureInPictureElement) {
          await document.exitPictureInPicture()
          setCastConnected(false)
        } else {
          await video.requestPictureInPicture()
          setCastConnected(true)
          setCastLabel("Picture in Picture")
        }
        return
      }
    } catch {
      // ignore
    }

    // 5) Not supported
    setCastAvailable(false)
  }, [])

  const selectLevel = useCallback((level) => {
    if (hlsRef.current) {
      try {
        hlsRef.current.currentLevel = level
        setCurrentLevel(level)
      } catch {
        // ignore
      }
    }
    setShowSettings(false)
  }, [])

  // ---- Keyboard shortcuts (REPLACED useEffect) ----
  useEffect(() => {
    const onKey = (e) => {
      const active = document.activeElement
      if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable)) return

      const video = videoRef.current
      if (!video) return

      const key = e.key

      switch (key) {
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
          try {
            video.currentTime = Math.max(0, video.currentTime - 10)
          } catch {}
          break
        case "ArrowRight":
          e.preventDefault()
          try {
            video.currentTime = video.currentTime + 10
          } catch {}
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
        aria-label="Live video player"
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
          style={{ opacity: 0.55 }}
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
                onClick={() => {
                  if (subtitleTracks.length === 0) return
                  setShowCaptions((s) => !s)
                  if (!showCaptions && selectedSubtitle === "off") {
                    // enable auto if turning on
                    setSelectedSubtitle("auto")
                    // if HLS available, pick default via hls event; else show native tracks
                    if (hlsRef.current && hlsRef.current.subtitleTracks && hlsRef.current.subtitleTracks.length > 0) {
                      const defIdx = hlsRef.current.subtitleTracks.findIndex((t) => t.default)
                      const idx = defIdx >= 0 ? defIdx : 0
                      try {
                        hlsRef.current.subtitleTrack = idx
                        setSelectedSubtitle(hlsRef.current.subtitleTracks[idx].id ?? `hls-${idx}`)
                      } catch {}
                    } else {
                      const video = videoRef.current
                      if (video && video.textTracks && video.textTracks.length > 0) {
                        for (let i = 0; i < video.textTracks.length; i++) {
                          video.textTracks[i].mode = "showing"
                        }
                      }
                    }
                  }
                }}
                label={subtitleTracks.length === 0 ? "No captions available" : "Captions"}
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
