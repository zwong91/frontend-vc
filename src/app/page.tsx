"use client";

import { useEffect, useState, useRef } from "react";
import styles from "./page.module.css";
import msgpack from 'msgpack-lite';

export default function Home() {
  const [mediaRecorder, setMediaRecorder] = useState<MediaRecorder | null>(null);
  const [isRecording, setIsRecording] = useState(true); // true means listening, false means speaking
  const [isPlayingAudio, setIsPlayingAudio] = useState(false); // State to track audio playback
  const [socket, setSocket] = useState<WebSocket | null>(null);
  const [audioQueue, setAudioQueue] = useState<Blob[]>([]);
  const [audioDuration, setAudioDuration] = useState<number>(0); // State to track audio duration

  const [isCallEnded, setIsCallEnded] = useState(false); // Add this state

  // 定义可能的连接状态类型
  type ConnectionStatus = "Connecting..." | "Connected" | "Disconnected" | "Closed";

  const [connectionStatus, setConnectionStatus] = useState<string>("Connecting..."); // State to track connection status

  let manualClose = false;
  let audioContext: AudioContext | null = null;
  let audioBufferQueue: AudioBuffer[] = [];

  // Check if AudioContext is available in the browser
  if (typeof window !== "undefined" && window.AudioContext) {
    audioContext = new AudioContext();
  }

  const audioManager = {
    stopCurrentAudio: () => {
      if (isPlayingAudio) {
        setIsPlayingAudio(false);
      }
    },

    playNewAudio: async (audioBlob: Blob) => {
      const audioUrl = URL.createObjectURL(audioBlob);
      const audio = new Audio(audioUrl);

      // When the metadata of the audio is loaded, set its duration
      audio.onloadedmetadata = () => {
        setAudioDuration(audio.duration); // Set the audio duration after loading metadata
      };

      // Play the audio
      setIsPlayingAudio(true);

      audio.onended = () => {
        URL.revokeObjectURL(audioUrl);
        setIsPlayingAudio(false);
        setIsRecording(true);

        if (audioQueue.length > 0) {
          const nextAudioBlob = audioQueue.shift();
          if (nextAudioBlob) {
            audioManager.playNewAudio(nextAudioBlob); // Play next audio in the queue
          }
        }
      };

      try {
        await audio.play();
      } catch (error) {
        console.error("播放音频失败:", error);
        audioManager.stopCurrentAudio();
      }
    }
  };

  // 检查 ArrayBuffer 是否包含 "END_OF_AUDIO" 并处理音频数据
  function checkAndBufferAudio(audioData: ArrayBuffer) {
    // 将 ArrayBuffer 转为字符串
    const text = new TextDecoder("utf-8").decode(audioData);

    if (text.includes("END_OF_AUDIO")) {
      console.log("Detected END_OF_AUDIO signal in audioData");
      // 停止当前音频播放
      audioManager.stopCurrentAudio();
      // 停止录音并切换状态
      setIsRecording(true);
      setIsPlayingAudio(false);
      return;
    }
    // 如果不包含 END_OF_AUDIO，则缓冲音频数据
    bufferAudio(audioData);
  }

  // Buffer audio and add it to the queue
  function bufferAudio(data: ArrayBuffer) {
    if (audioContext) {
      audioContext.decodeAudioData(data, (buffer) => {
        // Buffer the audio chunk and push it to the queue
        audioBufferQueue.push(buffer);

        // If we are not already playing, start playing the audio
        if (!isPlayingAudio) {
          playAudioBufferQueue();
        }
      });
    }
  }

  // Play the buffered audio chunks from the queue
  function playAudioBufferQueue() {
    if (audioBufferQueue.length === 0) {
      setIsPlayingAudio(false); // Stop playback if queue is empty
      setIsRecording(true); // Start recording again
      return;
    }

    const buffer = audioBufferQueue.shift(); // Get the next audio buffer
    if (buffer && audioContext) {
      const source = audioContext.createBufferSource();
      source.buffer = buffer;

      // Connect the source to the audio context's output
      source.connect(audioContext.destination);

      // When this audio ends, play the next one
      source.onended = () => {
        playAudioBufferQueue(); // Continue playing the next buffer
      };

      // Start playing the audio
      source.start();

      // Update the state to reflect the playing status
      setIsPlayingAudio(true);
    }
  }

  //const SOCKET_URL = "wss://gtp.aleopool.cc/stream";
  const SOCKET_URL = "wss://audio.enty.services/stream";

 let websocket: WebSocket | null = null;

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
                if (manualClose || isCallEnded) {
                  console.log("Reconnection prevented by manualClose or isCallEnded flag.");
                  return;
                }
    
                if (websocket) websocket.close();
                websocket = new WebSocket(SOCKET_URL);
                setSocket(websocket);
    
                websocket.onopen = () => {
                  console.log("client connected to websocket");
                  setConnectionStatus("Connected");
                  setIsInCall(true);
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
                              event: "start",
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
                            // Encode the data using MessagePack
                            // const encodedData = msgpack.encode(message);
                            const encodedData = JSON.stringify(message);
                            if (websocket) {
                              websocket.send(encodedData);
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

                  console.log("Received message:", event.data);
                  try {
        
                      setIsRecording(false);
                      setIsPlayingAudio(true);
                      if (event.data instanceof Blob) {
                          // 如果是 Blob 类型，使用 FileReader 将其转换为 ArrayBuffer
                          const reader = new FileReader();
                          reader.onloadend = () => {
                            checkAndBufferAudio(reader.result as ArrayBuffer);
                          };
                          reader.readAsArrayBuffer(event.data);
                          return; // 需要提前退出，等 FileReader 读取完成后再继续处理
                      }else {
                        throw new Error("Unsupported data type received");
                      }
                  } catch (error) {
                    console.error("Error processing WebSocket message:", error);
                  }

                };
    
                websocket.onclose = () => {
                  if (manualClose || isCallEnded) return; // Don't reconnect if the call has ended
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
    
              if (manualClose || isCallEnded) return;
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

  // Handle media recorder pause/resume
  useEffect(() => {
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      if (isRecording) {
        mediaRecorder.resume();
      } else {
        mediaRecorder.pause();
      }
    }
  }, [isRecording, mediaRecorder]);

  function arrayBufferToBase64(arrayBuffer: ArrayBuffer): string {
    let binary = '';
    const uint8Array = new Uint8Array(arrayBuffer);
    const len = uint8Array.length;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(uint8Array[i]);
    }
    return btoa(binary);
  }

  // 添加状态来跟踪是否在通话中
  const [isInCall, setIsInCall] = useState(true);

  const endCall = async () => {
    manualClose = true;
    setConnectionStatus("Closed");
    setIsCallEnded(true); // Set isCallEnded to true to prevent reconnection

    if (socket) {
      socket.close();
      setSocket(null);
    }

    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
      mediaRecorder.stream.getTracks().forEach(track => track.stop());
      setMediaRecorder(null);
    }

    setIsInCall(false);
    setIsRecording(false);
    setIsPlayingAudio(false);
  };

  return (
    <div className={styles.container}>
      <div className={styles.statusBar}>
        <div className={styles.connectionStatus}>
          <div
            className={`${styles.statusDot} ${
              connectionStatus === "Connected" ? styles.connected : ""
            }`}
          />
          {connectionStatus}
        </div>
      </div>

      <div className={styles.mainContent}>
        <div className={styles.avatarSection}>
          <div
            className={`${styles.avatarContainer} ${
              isPlayingAudio ? styles.speaking : ""
            }`}
          >
            <img src="/ai-avatar.png" alt="AI" className={styles.avatar} />
          </div>
          <div className={styles.status}>
            <span className={isInCall ? (isPlayingAudio ? styles.speakingAnimation : styles.listeningAnimation) : styles.offlineAnimation}>
              {isInCall ? (isPlayingAudio ? "AI正在说话" : "AI正在听") : "AI 离线"}
            </span>
          </div>
        </div>
      </div>

      <div className={styles.controls}>
        <button
          className={isInCall ? styles.endCallButton : styles.startCallButton}
          onClick={() => {
            if (isInCall) {
              endCall();
            } else {
              window.location.reload();
            }
          }}
        >
          {isInCall ? "结束通话" : "重新通话"}
        </button>
      </div>
    </div>
  );
}
