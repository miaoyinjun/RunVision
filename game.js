const GAME_SECONDS = 30;
const TRACK_METERS = 100;
const PLAYER_MAX_SPEED = 10.5;
const STEP_WINDOW_MS = 1800;

const els = {
  video: document.querySelector("#camera"),
  overlay: document.querySelector("#overlay"),
  cameraStatus: document.querySelector("#cameraStatus"),
  startCameraBtn: document.querySelector("#startCameraBtn"),
  startRaceBtn: document.querySelector("#startRaceBtn"),
  finishLine: document.querySelector(".finish-line"),
  countdownBurst: document.querySelector("#countdownBurst"),
  finishBurst: document.querySelector("#finishBurst"),
  finishText: document.querySelector("#finishText"),
  playerRunner: document.querySelector("#playerRunner"),
  aiRunner: document.querySelector("#aiRunner"),
  timeLeft: document.querySelector("#timeLeft"),
  playerMeters: document.querySelector("#playerMeters"),
  aiMeters: document.querySelector("#aiMeters"),
  cadence: document.querySelector("#cadence"),
  result: document.querySelector("#result"),
  difficulty: document.querySelector("#difficulty"),
  difficultyValue: document.querySelector("#difficultyValue"),
};

const state = {
  detector: null,
  cameraReady: false,
  raceActive: false,
  countdownActive: false,
  raceStart: 0,
  lastFrame: 0,
  playerDistance: 0,
  aiDistance: 0,
  playerSpeed: 0,
  aiSpeed: Number(els.difficulty.value),
  stepTimes: [],
  lastKneeSignal: 0,
  lastStepAt: 0,
  previousMotionFrame: null,
  fallbackMotion: 0,
};

const overlayContext = els.overlay.getContext("2d", { alpha: true });
const motionCanvas = document.createElement("canvas");
motionCanvas.width = 80;
motionCanvas.height = 60;
const motionContext = motionCanvas.getContext("2d", { willReadFrequently: true });

els.startCameraBtn.addEventListener("click", startCamera);
els.startRaceBtn.addEventListener("click", startRace);
els.difficulty.addEventListener("input", () => {
  state.aiSpeed = Number(els.difficulty.value);
  els.difficultyValue.textContent = `${state.aiSpeed.toFixed(1)} m/s`;
});

resetRace();

async function startCamera() {
  els.startCameraBtn.disabled = true;
  resetRace();
  els.result.className = "result";
  els.result.textContent = "站到镜头前，开启摄像头后原地跑。步伐越明显，游戏里的人跑得越快。";
  setStatus("正在请求摄像头...");

  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("当前页面不能调用摄像头，请用 http://localhost 打开，不要直接双击 index.html 或使用局域网 IP。");
    }

    const stream = await requestCameraStream();

    els.video.srcObject = stream;
    await els.video.play();
    resizeOverlay();
    state.cameraReady = true;
    els.startRaceBtn.disabled = false;
    setStatus("摄像头已开启，正在加载姿态识别...");
    loadPoseDetector();
    requestAnimationFrame(tick);
  } catch (error) {
    els.startCameraBtn.disabled = false;
    setStatus("摄像头开启失败");
    console.error("Camera request failed.", error);
    els.result.textContent = getCameraErrorMessage(error);
  }
}

async function requestCameraStream() {
  const preferredConstraints = {
    video: {
      width: { ideal: 960 },
      height: { ideal: 720 },
      facingMode: "user",
    },
    audio: false,
  };

  try {
    return await navigator.mediaDevices.getUserMedia(preferredConstraints);
  } catch (error) {
    if (error.name !== "OverconstrainedError" && error.name !== "NotFoundError") {
      throw error;
    }

    return navigator.mediaDevices.getUserMedia({
      video: true,
      audio: false,
    });
  }
}

function getCameraErrorMessage(error) {
  const fallback = error.message || "请检查浏览器摄像头权限。";
  const messages = {
    NotAllowedError: "摄像头权限被拒绝了。请在浏览器地址栏左侧重新允许摄像头权限，然后再点开启摄像头。",
    NotFoundError: "没有找到可用摄像头。请确认摄像头已连接，并且没有被系统禁用。",
    NotReadableError: "摄像头正在被其他应用占用。请关闭会议软件、相机应用或其他网页后再试。",
    SecurityError: "当前页面不允许访问摄像头。请用 http://localhost 打开项目，或使用 HTTPS。",
    OverconstrainedError: "浏览器找不到符合要求的摄像头参数，已尝试降级；如果仍失败，请检查摄像头设备。",
  };

  return `无法访问摄像头：${messages[error.name] || fallback}`;
}

async function loadPoseDetector() {
  try {
    const vision = await import("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18");
    const fileset = await vision.FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm",
    );

    state.detector = await vision.PoseLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath:
          "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task",
        delegate: "GPU",
      },
      runningMode: "VIDEO",
      numPoses: 1,
      minPoseDetectionConfidence: 0.45,
      minPosePresenceConfidence: 0.45,
      minTrackingConfidence: 0.45,
    });

    setStatus("姿态识别就绪");
  } catch (error) {
    setStatus("姿态模型未加载，使用运动检测");
    console.warn("Pose detector unavailable, fallback motion detection is active.", error);
  }
}

function startRace() {
  if (!state.cameraReady || state.countdownActive) return;

  resetRace();
  hideFinishBurst();
  runCountdown();
  els.startRaceBtn.disabled = true;
  els.result.className = "result";
  els.result.textContent = "准备！倒计时结束后开始原地快跑。";
}

function resetRace() {
  state.raceActive = false;
  state.countdownActive = false;
  state.playerDistance = 0;
  state.aiDistance = 0;
  state.playerSpeed = 0;
  state.stepTimes = [];
  state.lastKneeSignal = 0;
  state.lastStepAt = 0;
  els.timeLeft.textContent = GAME_SECONDS.toFixed(1);
  hideCountdown();
  hideFinishBurst();
  renderScore();
  renderRunners();
  els.playerRunner.classList.add("paused");
  els.aiRunner.classList.add("paused");
}

function tick(now) {
  if (!state.cameraReady) return;

  resizeOverlay();
  const pose = estimatePose(now);
  const fallback = estimateFallbackMotion();
  updateCadence(pose, fallback, now);
  drawOverlay(pose);

  if (state.raceActive) {
    const elapsed = Math.min((now - state.raceStart) / 1000, GAME_SECONDS);
    const dt = Math.min((now - state.lastFrame) / 1000, 0.08);
    state.lastFrame = now;

    state.playerDistance = Math.min(TRACK_METERS, state.playerDistance + state.playerSpeed * dt);
    state.aiDistance = Math.min(TRACK_METERS, state.aiDistance + state.aiSpeed * dt);
    els.timeLeft.textContent = Math.max(GAME_SECONDS - elapsed, 0).toFixed(1);

    if (elapsed >= GAME_SECONDS || state.playerDistance >= TRACK_METERS || state.aiDistance >= TRACK_METERS) {
      finishRace();
    }
  }

  renderScore();
  renderRunners();
  requestAnimationFrame(tick);
}

function runCountdown() {
  state.countdownActive = true;
  const sequence = ["3", "2", "1"];
  let index = 0;

  showCountdown(sequence[index]);
  const timer = window.setInterval(() => {
    index += 1;

    if (index < sequence.length) {
      showCountdown(sequence[index]);
      return;
    }

    window.clearInterval(timer);
    hideCountdown();
    beginRace();
  }, 1000);
}

function beginRace() {
  if (!state.cameraReady) return;

  state.countdownActive = false;
  state.raceActive = true;
  state.raceStart = performance.now();
  state.lastFrame = state.raceStart;
  els.result.textContent = "比赛开始！面对摄像头原地快跑，抬膝和摆臂都会提高速度。";
  els.playerRunner.classList.remove("paused");
  els.aiRunner.classList.remove("paused");
}

function showCountdown(value) {
  els.countdownBurst.textContent = value;
  els.countdownBurst.className = "countdown-burst";
  void els.countdownBurst.offsetWidth;
  els.countdownBurst.className = "countdown-burst show";
  els.countdownBurst.setAttribute("aria-hidden", "false");
}

function hideCountdown() {
  els.countdownBurst.className = "countdown-burst";
  els.countdownBurst.setAttribute("aria-hidden", "true");
}

function estimatePose(now) {
  if (!state.detector || els.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    return null;
  }

  const result = state.detector.detectForVideo(els.video, now);
  return result.landmarks?.[0] || null;
}

function updateCadence(landmarks, fallbackMotion, now) {
  const poseSignal = getRunningSignal(landmarks);
  const signal = poseSignal ?? fallbackMotion;
  const delta = Math.abs(signal - state.lastKneeSignal);
  const minGap = poseSignal ? 150 : 230;
  const threshold = poseSignal ? 0.07 : 0.18;

  if (delta > threshold && now - state.lastStepAt > minGap) {
    state.stepTimes.push(now);
    state.lastStepAt = now;
  }

  state.lastKneeSignal = signal;
  state.stepTimes = state.stepTimes.filter((time) => now - time < STEP_WINDOW_MS);

  const cadence = state.stepTimes.length / (STEP_WINDOW_MS / 1000);
  const signalBoost = Math.min(delta * 9, 1.8);
  const targetSpeed = Math.min(PLAYER_MAX_SPEED, cadence * 2.35 + signalBoost);
  state.playerSpeed += (targetSpeed - state.playerSpeed) * 0.18;
}

function getRunningSignal(landmarks) {
  if (!landmarks) return null;

  const leftHip = landmarks[23];
  const rightHip = landmarks[24];
  const leftKnee = landmarks[25];
  const rightKnee = landmarks[26];
  const leftAnkle = landmarks[27];
  const rightAnkle = landmarks[28];
  const points = [leftHip, rightHip, leftKnee, rightKnee, leftAnkle, rightAnkle];

  if (points.some((point) => !point || point.visibility < 0.35)) {
    return null;
  }

  const leftLift = leftHip.y - leftKnee.y + (leftKnee.y - leftAnkle.y) * 0.4;
  const rightLift = rightHip.y - rightKnee.y + (rightKnee.y - rightAnkle.y) * 0.4;
  return leftLift - rightLift;
}

function estimateFallbackMotion() {
  if (els.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return state.fallbackMotion;

  motionContext.drawImage(els.video, 0, 0, motionCanvas.width, motionCanvas.height);
  const frame = motionContext.getImageData(0, 0, motionCanvas.width, motionCanvas.height);

  if (!state.previousMotionFrame) {
    state.previousMotionFrame = frame;
    return state.fallbackMotion;
  }

  let diff = 0;
  for (let i = 0; i < frame.data.length; i += 16) {
    diff += Math.abs(frame.data[i] - state.previousMotionFrame.data[i]);
  }

  state.previousMotionFrame = frame;
  state.fallbackMotion = Math.min(diff / 18000, 1.2);
  return state.fallbackMotion;
}

function finishRace() {
  state.raceActive = false;
  els.startRaceBtn.disabled = false;
  els.playerRunner.classList.add("paused");
  els.aiRunner.classList.add("paused");

  const won = state.playerDistance >= state.aiDistance;
  showFinishBurst(won);
  els.result.className = `result ${won ? "win" : "lose"}`;
  els.result.textContent = won
    ? `Win！你跑了 ${state.playerDistance.toFixed(1)} 米，电脑跑了 ${state.aiDistance.toFixed(1)} 米。`
    : `Lose！你跑了 ${state.playerDistance.toFixed(1)} 米，电脑跑了 ${state.aiDistance.toFixed(1)} 米。`;
  closeCameraAfterRace();
}

function showFinishBurst(won) {
  els.finishText.textContent = won ? "WIN" : "LOSE";
  els.finishBurst.className = `finish-burst show ${won ? "win" : "lose"}`;
  els.finishBurst.setAttribute("aria-hidden", "false");
}

function hideFinishBurst() {
  els.finishBurst.className = "finish-burst";
  els.finishBurst.setAttribute("aria-hidden", "true");
}

function closeCameraAfterRace() {
  const stream = els.video.srcObject;

  if (stream) {
    stream.getTracks().forEach((track) => track.stop());
  }

  els.video.srcObject = null;
  overlayContext.clearRect(0, 0, els.overlay.width, els.overlay.height);
  state.cameraReady = false;
  state.previousMotionFrame = null;
  state.fallbackMotion = 0;
  els.startCameraBtn.disabled = false;
  els.startRaceBtn.disabled = true;
  setStatus("比赛结束，摄像头已关闭");
}

function renderScore() {
  els.playerMeters.textContent = state.playerDistance.toFixed(1);
  els.aiMeters.textContent = state.aiDistance.toFixed(1);
  els.cadence.textContent = `${Math.round(state.stepTimes.length / (STEP_WINDOW_MS / 1000) * 60)}`;
}

function renderRunners() {
  const playerProgress = Math.min(state.playerDistance / TRACK_METERS, 1);
  const aiProgress = Math.min(state.aiDistance / TRACK_METERS, 1);
  const playerX = getRunnerTranslateX(els.playerRunner, playerProgress);
  const aiX = getRunnerTranslateX(els.aiRunner, aiProgress);
  els.playerRunner.style.transform = `translate3d(${playerX}px, 0, 0) rotate(-8deg)`;
  els.aiRunner.style.transform = `translate3d(${aiX}px, 0, 0) rotate(-8deg)`;

  const playerStride = Math.max(160, 520 - state.playerSpeed * 34);
  const aiStride = Math.max(170, 530 - state.aiSpeed * 32);
  els.playerRunner.style.setProperty("--stride", `${playerStride}ms`);
  els.aiRunner.style.setProperty("--stride", `${aiStride}ms`);
  els.playerRunner.querySelectorAll(".arm, .leg").forEach((part) => {
    part.style.animationDuration = `${playerStride}ms`;
  });
  els.aiRunner.querySelectorAll(".arm, .leg").forEach((part) => {
    part.style.animationDuration = `${aiStride}ms`;
  });
}

function getRunnerTranslateX(runner, progress) {
  const finishX = els.finishLine.offsetLeft;
  const startX = runner.offsetLeft;
  const runnerWidth = runner.offsetWidth;
  const finishPadding = Math.max(6, els.finishLine.offsetWidth * 0.5);
  const finishTranslateX = Math.max(0, finishX - startX - runnerWidth + finishPadding);

  return Math.round(finishTranslateX * progress);
}

function drawOverlay(landmarks) {
  const { width, height } = els.overlay;
  overlayContext.clearRect(0, 0, width, height);

  if (!landmarks) return;

  overlayContext.lineWidth = 4;
  overlayContext.strokeStyle = "#15d2c0";
  overlayContext.fillStyle = "#f6c542";
  drawBone(landmarks[23], landmarks[25], width, height);
  drawBone(landmarks[25], landmarks[27], width, height);
  drawBone(landmarks[24], landmarks[26], width, height);
  drawBone(landmarks[26], landmarks[28], width, height);

  [23, 24, 25, 26, 27, 28].forEach((index) => {
    const point = landmarks[index];
    if (!point || point.visibility < 0.35) return;
    overlayContext.beginPath();
    overlayContext.arc(point.x * width, point.y * height, 5, 0, Math.PI * 2);
    overlayContext.fill();
  });
}

function drawBone(a, b, width, height) {
  if (!a || !b || a.visibility < 0.35 || b.visibility < 0.35) return;

  overlayContext.beginPath();
  overlayContext.moveTo(a.x * width, a.y * height);
  overlayContext.lineTo(b.x * width, b.y * height);
  overlayContext.stroke();
}

function resizeOverlay() {
  const width = els.video.videoWidth || els.overlay.clientWidth;
  const height = els.video.videoHeight || els.overlay.clientHeight;
  if (els.overlay.width !== width || els.overlay.height !== height) {
    els.overlay.width = width;
    els.overlay.height = height;
  }
}

function setStatus(message) {
  els.cameraStatus.textContent = message;
}
