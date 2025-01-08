"use client";

import { useEffect, useState, useRef } from "react";
import styles from "./page.module.css";
import { useMicVAD, utils } from "@ricky0123/vad-react"

import LanguageSelection from './languageselect';

// 音频管理器
const useAudioManager = (audioQueue: Blob[], setAudioQueue: Function, setIsRecording: Function) => {
  const [isPlayingAudio, setIsPlayingAudio] = useState(false);
  const [audioDuration, setAudioDuration] = useState<number>(0);
  const [currentAudio, setCurrentAudio] = useState<HTMLAudioElement | null>(null); // 追踪当前播放的音频

  const stopCurrentAudio = () => {
    if (currentAudio) {
      currentAudio.pause();
      currentAudio.currentTime = 0;
      setIsPlayingAudio(false);
    }
  };

  const playAudio = async (audioBlob: Blob) => {
    const audioUrl = URL.createObjectURL(audioBlob);
    const audio = new Audio(audioUrl);
    setCurrentAudio(audio); // 设置当前播放的音频对象

    audio.onloadedmetadata = () => setAudioDuration(audio.duration);

    audio.onended = () => {
      URL.revokeObjectURL(audioUrl);
      setIsPlayingAudio(false);

      if (audioQueue.length > 0) {
        const nextAudioBlob = audioQueue.shift();
        if (nextAudioBlob) {
          playAudio(nextAudioBlob);
        }
      } else {
        // 播放完所有音频后清空队列
        setAudioQueue([]);
        setIsRecording(true);
      }
    };

    try {
      setIsPlayingAudio(true);
      await audio.play();
    } catch (error) {
      console.error("播放音频失败:", error);
      setIsPlayingAudio(false);
    }
  };

  const checkAndBufferAudio = (audioData: ArrayBuffer) => {
    const text = new TextDecoder("utf-8").decode(audioData);

    if (text.includes("END_OF_AUDIO")) {
      console.log("Detected END_OF_AUDIO signal in audioData");
      stopCurrentAudio(); // 停止当前音频播放
      setIsRecording(true);
      setIsPlayingAudio(false);
      return;
    }

    // 如果没有检测到 "END_OF_AUDIO" 信号，继续缓存音频并立即播放
    const audioBlob = new Blob([audioData], { type: "audio/wav" });
    setAudioQueue((prevQueue: Blob[]) => {
      const newQueue = [...prevQueue, audioBlob];
      return newQueue;
    });
  };

  return {
    isPlayingAudio,
    audioDuration,
    playAudio,
    checkAndBufferAudio,
    stopCurrentAudio,
  };
};

const useWebSocket = (
  audioQueue: Blob[],
  setAudioQueue: Function,
  setIsRecording: Function,
  checkAndBufferAudio: Function,
  isSimultaneous: boolean,
  targetLang: string
) => {
  const [connectionStatus, setConnectionStatus] = useState("connecting");
  const [isCallEnded, setIsCallEnded] = useState(false);
  const [ws, setSocket] = useState<WebSocket | null>(null);
  const [reconnectAttempts, setReconnectAttempts] = useState(0);
  const [reconnectTimer, setReconnectTimer] = useState<NodeJS.Timeout | null>(null);

  const SOCKET_URL = "wss://audio.enty.services/stream";

  useEffect(() => {
    if (typeof window !== "undefined") {
      const setupConnection = async () => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          console.log("WebSocket already connected.");
          return;
        }

        try {
          const script = document.createElement("script");
          script.src = "https://www.WebRTC-Experiment.com/RecordRTC.js";
          script.onload = () => {
            const RecordRTC = (window as any).RecordRTC;
            const StereoAudioRecorder = (window as any).StereoAudioRecorder;

            const newWs = new WebSocket(SOCKET_URL);
            setSocket(newWs);
            setConnectionStatus("Connecting...");

            newWs.onopen = () => {
              console.log("client connected to ws");
              setConnectionStatus("Connected");

              // 发送配置数据
              const audioConfig = {
                type: 'config',
                data: {
                  is_simultaneous: isSimultaneous,
                  target_lang: targetLang,
                }
              };
              newWs.send(JSON.stringify(audioConfig));

              // 获取用户媒体
              navigator.mediaDevices.getUserMedia({ audio: true })
                .then((stream) => {
                  const recorder = new RecordRTC(stream, {
                    type: 'audio',
                    recorderType: StereoAudioRecorder,
                    mimeType: 'audio/wav',
                    timeSlice: 100,
                    desiredSampRate: 16000,
                    numberOfAudioChannels: 1,
                    ondataavailable: (blob: Blob) => {
                      if (blob.size > 0) {
                        const reader = new FileReader();
                        reader.onloadend = () => {
                          if (reader.result) {
                            const base64data = arrayBufferToBase64(reader.result as ArrayBuffer);

                            const message = {
                              type: "start",
                              request: {
                                audio: base64data,
                                latency: "normal",
                                format: "opus",
                                prosody: {
                                  speed: 1.0,
                                  volume: 0
                                },
                                vc_uid: "c9cf4e49"
                              }
                            };

                            const encodedData = JSON.stringify(message);
                            newWs.send(encodedData);
                          } else {
                            console.error("FileReader result is null");
                          }
                        };
                        reader.readAsArrayBuffer(blob);
                      }
                    }
                  });

                  recorder.startRecording();
                }).catch((error) => {
                  console.error("Error with getUserMedia", error);
                });
            };

            newWs.onmessage = (event) => {
              console.log("Received message:", event.data);
              try {
                setIsRecording(false);
                if (event.data instanceof Blob) {
                  const reader = new FileReader();
                  reader.onloadend = () => {
                    checkAndBufferAudio(reader.result as ArrayBuffer);
                  };
                  reader.readAsArrayBuffer(event.data);
                } else {
                  throw new Error("Unsupported data type received");
                }
              } catch (error) {
                console.error("Error processing WebSocket message:", error);
              }
            };

            newWs.onclose = () => {
              if (isCallEnded) return; // Don't reconnect if the call has ended
              console.log("WebSocket connection closed...");
              setConnectionStatus("Reconnecting...");

              // Only attempt to reconnect if not already disconnected and max reconnect attempts is not reached
              if (reconnectAttempts < 5) {
                setReconnectAttempts((prev: number) => prev + 1);
                setReconnectTimer(setTimeout(setupConnection, 5000));
              } else {
                console.log("Max reconnect attempts reached");
                setConnectionStatus("Disconnected");
              }
            };

            newWs.onerror = (error) => {
              console.error("WebSocket error:", error);
              newWs.close();
            };
          };

          document.body.appendChild(script);
        } catch (error) {
          console.error("WebSocket initialization failed:", error);
          setConnectionStatus("Disconnected");
        }
      };

      setupConnection();

      // Cleanup WebSocket and reconnection timer
      return () => {
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
        }
        if (ws) {
          ws.close();
          setConnectionStatus("Disconnected");
        }
      };
    } else {
      setConnectionStatus("WebSocket not supported");
    }
  }, [checkAndBufferAudio, isCallEnded, isSimultaneous, reconnectAttempts, reconnectTimer, setIsRecording, targetLang]);

  function arrayBufferToBase64(arrayBuffer: ArrayBuffer): string {
    let binary = '';
    const uint8Array = new Uint8Array(arrayBuffer);
    const len = uint8Array.length;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(uint8Array[i]);
    }
    return btoa(binary);
  }

  return {
    connectionStatus,
    isCallEnded,
    endCall: () => {
      if (ws) {
        ws.close();
      }
      setConnectionStatus("Disconnected");
      setIsCallEnded(true);
    },
    ws,
  };
};



// 主组件
export default function Home() {
  const [audioQueue, setAudioQueue] = useState<Blob[]>([]);
  const [isRecording, setIsRecording] = useState(true);
  const [audioList, setAudioList] = useState<string[]>([]);

  const [isSimultaneous, setIsSimultaneous] = useState(false);
  const [targetLang, setTargetLang] = useState('英语');
  const handleLanguageChange = (newIsSimultaneous: boolean, newTargetLang: string) => {
    setIsSimultaneous(newIsSimultaneous);
    setTargetLang(newTargetLang);
    console.log('Updated Language Config:', newIsSimultaneous, newTargetLang);

  // 在语言变化后触发发送配置数据
  if (ws && ws.readyState === WebSocket.OPEN) {
    const audioConfig = {
      type: 'config',
      data: {
        is_simultaneous: newIsSimultaneous,
        target_lang: newTargetLang,
      },
    };
    ws.send(JSON.stringify(audioConfig));
    console.log('Language config sent:', audioConfig);
  } else {
    console.error("ws is not open, unable to send data.");
  }

  };

  const audioItemKey = (audioURL: string) => audioURL.substring(-10)
  const vad = useMicVAD({
    model: "v5",
    baseAssetPath: "/",
    onnxWASMBasePath: "/",
    onSpeechEnd: (audio: Float32Array) => {
      const wavBuffer = utils.encodeWAV(audio);
      const base64 = utils.arrayBufferToBase64(wavBuffer);
      const url = `data:audio/wav;base64,${base64}`;
      setAudioList((old) => [url, ...old]);
    },
  });


  const { isPlayingAudio, playAudio, checkAndBufferAudio, stopCurrentAudio } = useAudioManager(
    audioQueue,
    setAudioQueue,
    setIsRecording
  );
  const { connectionStatus, isCallEnded, endCall, ws } = useWebSocket(
    audioQueue,
    setAudioQueue,
    setIsRecording,
    checkAndBufferAudio,
    isSimultaneous,
    targetLang
  );

  useEffect(() => {
    if (!isPlayingAudio && audioQueue.length > 0) {
      const nextAudioBlob = audioQueue.shift();
      if (nextAudioBlob) playAudio(nextAudioBlob);
    }
  }, [isPlayingAudio, audioQueue, playAudio]);

  // Integrate Eruda
  useEffect(() => {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/eruda';
    script.onload = () => {
      (window as any).eruda.init();
    };
    document.body.appendChild(script);
  }, []);

  // Add wake lock logic
  useEffect(() => {
    let wakeLock: WakeLockSentinel | null = null;

    // Request screen wake lock to prevent the screen from going to sleep
    const requestWakeLock = async () => {
      try {
        wakeLock = await navigator.wakeLock.request("screen");
        console.log("Screen wake lock acquired");
      } catch (error) {
        console.error("Error with requestWakeLock", error);
      }
    };

    requestWakeLock();

    return () => {
      if (wakeLock) {
        wakeLock.release().then(() => {
          console.log("Screen wake lock released");
        }).catch((error) => {
          console.error("Failed to release wake lock", error);
        });
      }
    };
  }, []);

  return (
    <div className={styles.container}>
      <div className={styles.statusBar}>
        <div className={styles.connectionStatus}>
          <div
            className={`${styles.statusDot} ${
              connectionStatus === "connected" ? styles.connected : ""
            }`}
          />
          {connectionStatus}
        </div>
      </div>

      <div className={styles.mainContent}>
        <div className={styles.avatarSection}>
          <div className={`${styles.avatarContainer} ${isPlayingAudio ? styles.speaking : ""}`}>
            <img src="/ai-avatar.png" alt="AI" className={styles.avatar} />
          </div>
          <div className={styles.status}>
            <span
              className={
                connectionStatus === "disconnected"
                  ? styles.offlineAnimation
                  : isPlayingAudio
                  ? styles.speakingAnimation
                  : styles.listeningAnimation
              }
            >
            {connectionStatus === "disconnected"
              ? "AI Offline"
              : isPlayingAudio
              ? "AI is Speaking"
              : "AI is Listening"}
            </span>
          </div>
        </div>
      </div>

      <div className={styles.langContent}>
        <LanguageSelection
          onLanguageChange={handleLanguageChange} // Pass the language change handler
        />
      </div>

      <div>
      {/* Add the VAD status */}
      <div>
        <h6>Listening</h6>
        {!vad.listening && "Not"} listening
        <h6>Loading</h6>
        {!vad.loading && "Not"} loading
        <h6>Errored</h6>
        {!vad.errored && "Not"} errored
        <h6>User Speaking</h6>
        {!vad.userSpeaking && "Not"} speaking
        <h6>Audio count</h6>
        {audioList.length}
        <h6>Start/Pause</h6>
        <button onClick={vad.pause}>Pause</button>
        <button onClick={vad.start}>Start</button>
        <button onClick={vad.toggle}>Toggle</button>
      </div>

      {/* Add the audio playlist */}
      <div>
        <ol
          id="playlist"
          className="self-center pl-0 max-h-[400px] overflow-y-auto no-scrollbar list-none"
        >
          {audioList.map((audioURL) => {
            return (
              <li className="pl-0" key={audioItemKey(audioURL)}>
                <audio src={audioURL} controls />
              </li>
            );
          })}
        </ol>
      </div>
    </div>

      <div className={styles.controls}>
        <button
          className={!isCallEnded ? styles.startCallButton : styles.endCallButton}
          onClick={() => {
            if (!isCallEnded) {
              endCall();
            } else {
              window.location.reload();
            }
          }}
        >
          {isCallEnded ? "Call Again" : "End Call"}
        </button>
      </div>
    </div>
  );
}
