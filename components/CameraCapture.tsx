"use client";
import { useCallback, useEffect, useRef, useState } from "react";

type Mode = "photo" | "video";

export function CameraCapture({
  onCapture,
  onClose,
}: {
  onCapture: (file: File) => void;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const [mode, setMode] = useState<Mode>("photo");
  const [recording, setRecording] = useState(false);
  const [preview, setPreview] = useState<{ url: string; type: Mode } | null>(null);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);

  const startStream = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: mode === "video" });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play();
      }
      setReady(true);
      setError("");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("Permission") || msg.includes("NotAllowed")) {
        setError("Camera permission denied. Please allow camera access and try again.");
      } else if (msg.includes("NotFound") || msg.includes("DevicesNotFound")) {
        setError("No camera found on this device.");
      } else {
        setError("Could not access camera: " + msg);
      }
    }
  }, [mode]);

  useEffect(() => {
    if (!preview) startStream();
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, [startStream, preview]);

  const capturePhoto = () => {
    if (!videoRef.current) return;
    const canvas = document.createElement("canvas");
    canvas.width = videoRef.current.videoWidth;
    canvas.height = videoRef.current.videoHeight;
    canvas.getContext("2d")?.drawImage(videoRef.current, 0, 0);
    canvas.toBlob((blob) => {
      if (!blob) return;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      const url = URL.createObjectURL(blob);
      setPreview({ url, type: "photo" });
    }, "image/jpeg", 0.9);
  };

  const startRecording = () => {
    if (!streamRef.current) return;
    chunksRef.current = [];
    const recorder = new MediaRecorder(streamRef.current);
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
    recorder.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: "video/webm" });
      streamRef.current?.getTracks().forEach((t) => t.stop());
      const url = URL.createObjectURL(blob);
      setPreview({ url, type: "video" });
    };
    recorder.start();
    recorderRef.current = recorder;
    setRecording(true);
  };

  const stopRecording = () => {
    recorderRef.current?.stop();
    setRecording(false);
  };

  const retake = () => {
    if (preview) URL.revokeObjectURL(preview.url);
    setPreview(null);
    setReady(false);
  };

  const send = async () => {
    if (!preview) return;
    const res = await fetch(preview.url);
    const blob = await res.blob();
    const ext = preview.type === "photo" ? "jpg" : "webm";
    const mime = preview.type === "photo" ? "image/jpeg" : "video/webm";
    const file = new File([blob], `capture.${ext}`, { type: mime });
    URL.revokeObjectURL(preview.url);
    onCapture(file);
    onClose();
  };

  return (
    <div className="camera-overlay" role="dialog" aria-label="Camera capture">
      <div className="camera-panel">
        <div className="camera-header">
          <button onClick={onClose} className="camera-close" aria-label="Close camera">✕</button>
          {!preview && (
            <div className="mode-switch" role="group">
              <button onClick={() => setMode("photo")} className={mode === "photo" ? "mode-active" : "mode-option"}>Photo</button>
              <button onClick={() => setMode("video")} className={mode === "video" ? "mode-active" : "mode-option"}>Video</button>
            </div>
          )}
          <div style={{ width: 32 }} />
        </div>

        {error ? (
          <div className="camera-error">
            <span className="text-3xl">📷</span>
            <p className="text-sm text-slate-300 text-center">{error}</p>
            <button onClick={onClose} className="btn-send mt-2">Close</button>
          </div>
        ) : preview ? (
          <div className="camera-preview">
            {preview.type === "photo" ? (
              <img src={preview.url} alt="Captured photo" className="camera-media" />
            ) : (
              <video src={preview.url} controls className="camera-media" />
            )}
            <div className="camera-actions">
              <button onClick={retake} className="btn-secondary">Retake</button>
              <button onClick={send} className="btn-send">Send</button>
            </div>
          </div>
        ) : (
          <div className="camera-viewfinder">
            <video ref={videoRef} muted playsInline className="camera-media" />
            {ready && (
              <div className="camera-controls">
                {mode === "photo" ? (
                  <button onClick={capturePhoto} className="camera-shutter" aria-label="Take photo">📸</button>
                ) : recording ? (
                  <button onClick={stopRecording} className="camera-shutter camera-shutter-recording" aria-label="Stop recording">⏹</button>
                ) : (
                  <button onClick={startRecording} className="camera-shutter" aria-label="Start recording">⏺</button>
                )}
              </div>
            )}
            {!ready && !error && (
              <div className="camera-loading">
                <p className="text-sm text-slate-400">Starting camera…</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
