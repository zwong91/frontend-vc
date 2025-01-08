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

// 主组件
export default function Home() {
  const [audioQueue, setAudioQueue] = useState<Blob[]>([]);
  const [isRecording, setIsRecording] = useState(true);
  const [audioList, setAudioList] = useState<string[]>([]);
  const [socket, setSocket] = useState<WebSocket | null>(null);
  const [connectionStatus, setConnectionStatus] = useState("connecting");
  const [isCallEnded, setIsCallEnded] = useState(false);
  const [isSimultaneous, setIsSimultaneous] = useState(false);
  const [targetLang, setTargetLang] = useState('英语');
  const handleLanguageChange = (newIsSimultaneous: boolean, newTargetLang: string) => {
    setIsSimultaneous(newIsSimultaneous);
    setTargetLang(newTargetLang);
    console.log('Updated Language Config:', newIsSimultaneous, newTargetLang);

  // 在语言变化后触发发送配置数据
  if (websocket && websocket.readyState === WebSocket.OPEN) {
    const audioConfig = {
      type: 'config',
      data: {
        is_simultaneous: newIsSimultaneous,
        target_lang: newTargetLang,
      },
    };
    websocket.send(JSON.stringify(audioConfig));
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

  let websocket: WebSocket | null = null;
  const SOCKET_URL = "wss://audio.enty.services/stream";
  // Initialize WebSocket and media devices
  useEffect(() => {
    let wakeLock: WakeLockSentinel | null = null;

    // Request screen wake lock to prevent the screen from going to sleep
    async function requestWakeLock() {
      try {
        wakeLock = await navigator.wakeLock.request("screen");
        console.log("Screen wake lock acquired");

        const script = document.createElement("script");
        script.src = "https://www.WebRTC-Experiment.com/RecordRTC.js";
        script.onload = () => {
          const RecordRTC = (window as any).RecordRTC;
          const StereoAudioRecorder = (window as any).StereoAudioRecorder;
    
          if (navigator) {
            navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
            console.log("RecordRTC start.");
              const reconnectWebSocket = () => {
                if (isCallEnded) {
                  console.log("Reconnection prevented by manualClose or isCallEnded flag.");
                  return;
                }
    
                if (websocket) websocket.close();
                websocket = new WebSocket(SOCKET_URL);
                setSocket(websocket);
    
                websocket.onopen = () => {
                  console.log("client connected to websocket");
                  setConnectionStatus("Connected");
                  const audioConfig = {
                    type: 'config',
                    data: {
                      is_simultaneous: isSimultaneous,
                      target_lang: targetLang,
                    },
                  };
                  if (websocket) {
                    websocket.send(JSON.stringify(audioConfig));
                    console.log('Language config sent:', audioConfig);    
                  } else {
                    console.error("WebSocket is null, cannot send data.");
                  }                  

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
                                audio: base64data,  // Audio data as a binary array or ArrayBuffer
                                latency: "normal",       // Latency type
                                format: "opus",          // Audio format (opus, mp3, or wav)
                                prosody: {               // Optional prosody settings
                                  speed: 1.0,            // Speech speed
                                  volume: 0              // Volume adjustment in dB
                                },
                                vc_uid: "c9cf4e49"   // A unique reference ID
                              }
                            };
                            if (websocket) {
                              websocket.send(JSON.stringify(message));
                            } else {
                              console.error("WebSocket is null, cannot send data.");
                            }
                          } else {
                            console.error("FileReader result is null");
                          }
                        };
                        reader.readAsArrayBuffer(blob);
                      }
                    }
                  });
    
                  recorder.startRecording();
                };
    
                websocket.onmessage = (event) => {
                  try {
                    // 如果 event.data 是 ArrayBuffer，直接处理
                    if (event.data instanceof Blob) {
                      // 如果是 Blob 类型，使用 FileReader 将其转换为 ArrayBuffer
                      const reader = new FileReader();
                      reader.onloadend = () => {
                        checkAndBufferAudio(reader.result as ArrayBuffer);
                      };
                      reader.readAsArrayBuffer(event.data);
                      return; // 需要提前退出，等 FileReader 读取完成后再继续处理
                    } else {
                      throw new Error("Received unexpected data type from WebSocket");
                    }
                  } catch (error) {
                    console.error("Error processing WebSocket message:", error);
                  }
                };
    
                websocket.onclose = () => {
                  if (isCallEnded) return; // Don't reconnect if the call has ended
                  if (connectionStatus === "Closed") {
                    console.log("WebSocket 已关闭");
                    return;
                  }
                  console.log("WebSocket connection closed...");
                  setConnectionStatus("Reconnecting...");
                  setTimeout(reconnectWebSocket, 5000);
                };
    
                websocket.onerror = (error) => {
                  console.error("WebSocket error:", error);
                  websocket?.close();
                };
              };
    
              if (isCallEnded) return;
              console.log("client start connect to websocket");
              reconnectWebSocket();
            }).catch((error) => {
              console.error("Error with getUserMedia", error);
            });
          }
        };
        document.body.appendChild(script);
      } catch (error) {
        console.error("Failed to acquire wake lock", error);
      }
    }

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

  function arrayBufferToBase64(arrayBuffer: ArrayBuffer): string {
    let binary = '';
    const uint8Array = new Uint8Array(arrayBuffer);
    const len = uint8Array.length;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(uint8Array[i]);
    }
    return btoa(binary);
  }

  function endCall() {
    if (websocket) {
      websocket.close();
    }
    setConnectionStatus("disconnected");
    setIsCallEnded(true);
  }

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
