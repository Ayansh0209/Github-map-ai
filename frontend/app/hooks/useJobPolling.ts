"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getJobStatus, StatusResponse } from "../lib/client";

const POLL_INTERVAL = 3000;

export interface JobPollingState {
  status: StatusResponse["status"] | "idle" | "submitting";
  progress: number;
  step: string;
  position: number;
  error: string | null;
  result: StatusResponse | null;
}

export function useJobPolling() {
  const [state, setState] = useState<JobPollingState>({
    status: "idle",
    progress: 0,
    step: "",
    position: 0,
    error: null,
    result: null,
  });

  const jobIdRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const poll = useCallback(async () => {
    if (!jobIdRef.current) return;

    try {
      const data = await getJobStatus(jobIdRef.current);

      switch (data.status) {
        case "queued":
        case "delayed":
          setState((prev) => ({
            ...prev,
            status: data.status,
            position: data.position ?? 0,
          }));
          break;

        case "processing":
          setState((prev) => ({
            ...prev,
            status: "processing",
            progress: data.progress ?? prev.progress,
            step: data.step ?? prev.step,
          }));
          break;

        case "done":
          stopPolling();
          setState({
            status: "done",
            progress: 100,
            step: "Complete",
            position: 0,
            error: null,
            result: data,
          });
          break;

        case "failed":
          stopPolling();
          setState((prev) => ({
            ...prev,
            status: "failed",
            error: data.error ?? "Unknown error",
          }));
          break;
      }
    } catch (err) {
      // network error — don't stop polling, retry next interval
      console.warn("[poll] Network error:", err);
    }
  }, [stopPolling]);

  const startPolling = useCallback(
    (jobId: string) => {
      stopPolling();
      jobIdRef.current = jobId;

      setState({
        status: "processing",
        progress: 0,
        step: "Starting...",
        position: 0,
        error: null,
        result: null,
      });

      // immediate first poll
      poll();

      timerRef.current = setInterval(poll, POLL_INTERVAL);
    },
    [poll, stopPolling]
  );

  const reset = useCallback(() => {
    stopPolling();
    jobIdRef.current = null;
    setState({
      status: "idle",
      progress: 0,
      step: "",
      position: 0,
      error: null,
      result: null,
    });
  }, [stopPolling]);

  useEffect(() => {
    return () => stopPolling();
  }, [stopPolling]);

  return { ...state, startPolling, reset };
}
