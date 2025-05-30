let detector;
let canvas;
let ctx;
let currentHeight = 160; // default height in cm
let geminiModel;

async function initPoseDetection() {
  const model = poseDetection.SupportedModels.MoveNet;
  const detectorConfig = {
    modelType: poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING,
  };
  detector = await poseDetection.createDetector(model, detectorConfig);
}

async function initGemini() {
  try {
    const genAI = new window.google.generativeAI.GoogleGenerativeAI(
      "GEMINI_API_KEY"
    );
    geminiModel = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
    });
    console.log("Gemini initialized successfully");
  } catch (error) {
    console.error("Error initializing Gemini:", error);
  }
}

async function detectPose(image) {
  const poses = await detector.estimatePoses(image);
  return poses;
}

function calculateMeasurements(pose, height) {
  const measurements = {};

  // Get keypoints
  const nose = pose.keypoints.find((k) => k.name === "nose");
  const leftEye = pose.keypoints.find((k) => k.name === "left_eye");
  const rightEye = pose.keypoints.find((k) => k.name === "right_eye");
  const leftEar = pose.keypoints.find((k) => k.name === "left_ear");
  const rightEar = pose.keypoints.find((k) => k.name === "right_ear");
  const leftShoulder = pose.keypoints.find((k) => k.name === "left_shoulder");
  const rightShoulder = pose.keypoints.find((k) => k.name === "right_shoulder");
  const leftHip = pose.keypoints.find((k) => k.name === "left_hip");
  const rightHip = pose.keypoints.find((k) => k.name === "right_hip");
  const leftKnee = pose.keypoints.find((k) => k.name === "left_knee");
  const rightKnee = pose.keypoints.find((k) => k.name === "right_knee");
  const leftAnkle = pose.keypoints.find((k) => k.name === "left_ankle");
  const rightAnkle = pose.keypoints.find((k) => k.name === "right_ankle");

  // Helper function to calculate midpoint
  function getMidpoint(point1, point2) {
    return {
      x: (point1.x + point2.x) / 2,
      y: (point1.y + point2.y) / 2,
    };
  }

  // Helper function to calculate curved distance between points
  function calculateCurvedDistance(start, end, controlPoints = []) {
    if (!start || !end) return null;

    // If no control points, calculate straight line distance
    if (controlPoints.length === 0) {
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      return Math.sqrt(dx * dx + dy * dy);
    }

    // Calculate total curved distance using control points
    let totalDistance = 0;
    let prevPoint = start;

    // Add distances between each segment
    for (const point of controlPoints) {
      const dx = point.x - prevPoint.x;
      const dy = point.y - prevPoint.y;
      totalDistance += Math.sqrt(dx * dx + dy * dy);
      prevPoint = point;
    }

    // Add final segment to end point
    const dx = end.x - prevPoint.x;
    const dy = end.y - prevPoint.y;
    totalDistance += Math.sqrt(dx * dx + dy * dy);

    return totalDistance;
  }

  // Estimate top of head position using ears
  let topOfHead;
  if (leftEar && rightEar) {
    const earMidpoint = getMidpoint(leftEar, rightEar);
    if (leftEye && rightEye) {
      const eyeMidpoint = getMidpoint(leftEye, rightEye);
      const earToEyeDistance = Math.abs(earMidpoint.y - eyeMidpoint.y);
      const estimatedHeadHeight = earToEyeDistance * 1.5;
      topOfHead = {
        x: earMidpoint.x,
        y: earMidpoint.y - estimatedHeadHeight,
      };
    }
  }

  // Calculate midpoints for each body segment
  const shoulderMidpoint =
    leftShoulder && rightShoulder
      ? getMidpoint(leftShoulder, rightShoulder)
      : null;
  const hipMidpoint =
    leftHip && rightHip ? getMidpoint(leftHip, rightHip) : null;
  const kneeMidpoint =
    leftKnee && rightKnee ? getMidpoint(leftKnee, rightKnee) : null;
  const ankleMidpoint =
    leftAnkle && rightAnkle ? getMidpoint(leftAnkle, rightAnkle) : null;

  // Calculate each segment's curved distance with additional control points
  const headToShoulderDistance = calculateCurvedDistance(
    topOfHead,
    shoulderMidpoint,
    [nose]
  );

  // For upper body, use spine curve (neck to hip)
  const upperBodyControlPoints = [];
  if (nose) upperBodyControlPoints.push(nose);
  if (shoulderMidpoint) upperBodyControlPoints.push(shoulderMidpoint);
  const shoulderToHipDistance = calculateCurvedDistance(
    shoulderMidpoint,
    hipMidpoint,
    upperBodyControlPoints
  );

  // For lower body, use natural curve of the back and legs
  const lowerBodyControlPoints = [];
  if (hipMidpoint) lowerBodyControlPoints.push(hipMidpoint);
  const hipToKneeDistance = calculateCurvedDistance(
    hipMidpoint,
    kneeMidpoint,
    lowerBodyControlPoints
  );
  const kneeToAnkleDistance = calculateCurvedDistance(
    kneeMidpoint,
    ankleMidpoint
  );

  // Calculate total height in pixels
  const totalHeightPixels =
    headToShoulderDistance +
    shoulderToHipDistance +
    hipToKneeDistance +
    kneeToAnkleDistance;

  // Calculate pixel to cm ratio based on input height
  const pixelToCmRatio = height / totalHeightPixels;

  // Calculate measurements
  if (headToShoulderDistance) {
    measurements.head = Math.round(headToShoulderDistance * pixelToCmRatio);
  }

  if (shoulderToHipDistance) {
    measurements.upperBody = Math.round(shoulderToHipDistance * pixelToCmRatio);
  }

  // Lower body is the sum of hip-to-knee and knee-to-ankle distances
  if (hipToKneeDistance && kneeToAnkleDistance) {
    measurements.lowerBody = Math.round(
      (hipToKneeDistance + kneeToAnkleDistance) * pixelToCmRatio
    );
    measurements.hipToKnee = Math.round(hipToKneeDistance * pixelToCmRatio);
    measurements.kneeToAnkle = Math.round(kneeToAnkleDistance * pixelToCmRatio);
  }

  return measurements;
}

async function analyzeWithGemini(measurements, imageData) {
  try {
    // Convert base64 image to blob
    const response = await fetch(imageData);
    const blob = await response.blob();

    // Calculate ratio
    const gcd = (a, b) => (b ? gcd(b, a % b) : a);
    const divisor = gcd(measurements.upperBody, measurements.lowerBody);
    const n = Math.round(measurements.upperBody / divisor);
    const m = Math.round(measurements.lowerBody / divisor);

    // Calculate percentages
    const totalHeight =
      measurements.head + measurements.upperBody + measurements.lowerBody;
    const upperBodyRatio = (
      (measurements.upperBody / totalHeight) *
      100
    ).toFixed(1);
    const lowerBodyRatio = (
      (measurements.lowerBody / totalHeight) *
      100
    ).toFixed(1);

    // Create image part for Gemini
    const imagePart = {
      inlineData: {
        data: imageData.split(",")[1],
        mimeType: "image/jpeg",
      },
    };

    // Create text part with measurements
    const textPart = `
      Analyze this person's body type based on the following measurements:
      - Total Height: ${totalHeight} cm
      - Head Height: ${measurements.head} cm
      - Upper Body: ${measurements.upperBody} cm
      - Lower Body: ${measurements.lowerBody} cm
      - Upper:Lower Ratio: ${n}:${m}
      - Upper Body Ratio: ${upperBodyRatio}%
      - Lower Body Ratio: ${lowerBodyRatio}%

      Please provide:
      1. Body type classification
      2. Brief description of the body proportions
      3. Any notable characteristics
    `;

    // Generate content with Gemini
    const result = await geminiModel.generateContent([textPart, imagePart]);
    const res = await result.response;
    return res.text();
  } catch (error) {
    console.error("Error analyzing with Gemini:", error);
    return "Error analyzing body type. Please try again.";
  }
}

function displayMeasurements(measurements) {
  const resultsDiv = document.getElementById("measurementResults");
  const totalHeight =
    measurements.head + measurements.upperBody + measurements.lowerBody;
  const upperBodyRatio = ((measurements.upperBody / totalHeight) * 100).toFixed(
    1
  );
  const lowerBodyRatio = ((measurements.lowerBody / totalHeight) * 100).toFixed(
    1
  );

  // Calculate n:m ratio
  const upperBodyLength = measurements.upperBody;
  const lowerBodyLength = measurements.lowerBody;
  const gcd = (a, b) => (b ? gcd(b, a % b) : a); // Greatest Common Divisor
  const divisor = gcd(upperBodyLength, lowerBodyLength);
  const n = Math.round(upperBodyLength / divisor);
  const m = Math.round(lowerBodyLength / divisor);

  resultsDiv.innerHTML = `
    <div style="display: flex; justify-content: space-between;">
      <div style="flex: 1; padding-right: 20px;">
        <h4>General Proportions</h4>
        <p>Total Height: ${totalHeight || "N/A"} cm</p>
        <p>Upper:Lower Ratio: ${n}:${m}</p>
        <p>Upper Body Ratio: ${upperBodyRatio}%</p>
        <p>Lower Body Ratio: ${lowerBodyRatio}%</p>
      </div>
      <div style="flex: 1; padding-left: 20px; border-left: 1px solid #ccc;">
        <h4>Detailed Measurements</h4>
        <p>Head Height: ${measurements.head || "N/A"} cm</p>
        <p>Upper Body: ${measurements.upperBody || "N/A"} cm</p>
        <p>Lower Body: ${measurements.lowerBody || "N/A"} cm</p>
        <p>Hip to Knee: ${measurements.hipToKnee || "N/A"} cm</p>
        <p>Knee to Ankle: ${measurements.kneeToAnkle || "N/A"} cm</p>
      </div>
    </div>
    <div id="bodyTypeAnalysis" style="margin-top: 20px; padding: 15px; background-color: #f8f9fa; border-radius: 5px;">
      <h4>Body Type Analysis</h4>
      <p>Analyzing body type with Gemini AI...</p>
    </div>
  `;

  // Get the image data from canvas
  const imageData = canvas.toDataURL("image/jpeg");

  // Send data to Gemini for analysis
  analyzeWithGemini(measurements, imageData).then((analysis) => {
    const analysisDiv = document.getElementById("bodyTypeAnalysis");
    analysisDiv.innerHTML = `
      <h4>Body Type Analysis</h4>
      <div style="white-space: pre-line;">${analysis}</div>
    `;
  });

  document.getElementById("measurements").style.display = "block";
}

function drawPose(poses) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const connections = [
    ["nose", "left_eye"],
    ["nose", "right_eye"],
    ["left_eye", "left_ear"],
    ["right_eye", "right_ear"],
    ["left_shoulder", "right_shoulder"],
    ["left_shoulder", "left_elbow"],
    ["right_shoulder", "right_elbow"],
    ["left_elbow", "left_wrist"],
    ["right_elbow", "right_wrist"],
    ["left_shoulder", "left_hip"],
    ["right_shoulder", "right_hip"],
    ["left_hip", "right_hip"],
    ["left_hip", "left_knee"],
    ["right_hip", "right_knee"],
    ["left_knee", "left_ankle"],
    ["right_knee", "right_ankle"],
  ];

  for (const pose of poses) {
    // Draw keypoints
    for (const keypoint of pose.keypoints) {
      if (keypoint.score > 0.3) {
        ctx.beginPath();
        ctx.arc(keypoint.x, keypoint.y, 5, 0, 2 * Math.PI);
        ctx.fillStyle = "red";
        ctx.fill();
      }
    }

    // Draw connections
    for (const [startName, endName] of connections) {
      const start = pose.keypoints.find((k) => k.name === startName);
      const end = pose.keypoints.find((k) => k.name === endName);

      if (start && end && start.score > 0.3 && end.score > 0.3) {
        ctx.beginPath();
        ctx.moveTo(start.x, start.y);
        ctx.lineTo(end.x, end.y);
        ctx.strokeStyle = "blue";
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }

    // Draw estimated top of head using ears
    const leftEar = pose.keypoints.find((k) => k.name === "left_ear");
    const rightEar = pose.keypoints.find((k) => k.name === "right_ear");
    const leftEye = pose.keypoints.find((k) => k.name === "left_eye");
    const rightEye = pose.keypoints.find((k) => k.name === "right_eye");

    if (leftEar && rightEar && leftEye && rightEye) {
      const earMidpoint = {
        x: (leftEar.x + rightEar.x) / 2,
        y: (leftEar.y + rightEar.y) / 2,
      };
      const eyeMidpoint = {
        x: (leftEye.x + rightEye.x) / 2,
        y: (leftEye.y + rightEye.y) / 2,
      };
      const earToEyeDistance = Math.abs(earMidpoint.y - eyeMidpoint.y);
      const estimatedHeadHeight = earToEyeDistance * 1.5;

      ctx.beginPath();
      ctx.arc(
        earMidpoint.x,
        earMidpoint.y - estimatedHeadHeight,
        5,
        0,
        2 * Math.PI
      );
      ctx.fillStyle = "green";
      ctx.fill();

      // Draw line from ear midpoint to top of head for visualization
      ctx.beginPath();
      ctx.moveTo(earMidpoint.x, earMidpoint.y);
      ctx.lineTo(earMidpoint.x, earMidpoint.y - estimatedHeadHeight);
      ctx.strokeStyle = "green";
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // Calculate and display measurements
    const measurements = calculateMeasurements(pose, currentHeight);
    displayMeasurements(measurements);
  }
}

window.onload = async function () {
  try {
    await initPoseDetection();
    await initGemini();

    const imageInput = document.getElementById("imageInput");
    const previewImage = document.getElementById("previewImage");
    const heightInput = document.getElementById("heightInput");
    canvas = document.getElementById("canvas");
    ctx = canvas.getContext("2d");

    heightInput.addEventListener("change", (event) => {
      currentHeight = parseInt(event.target.value);
      if (previewImage.style.display === "block") {
        detectPose(previewImage).then((poses) => {
          drawPose(poses);
        });
      }
    });

    imageInput.addEventListener("change", async (event) => {
      const file = event.target.files[0];
      if (file) {
        const reader = new FileReader();

        reader.onload = async (e) => {
          previewImage.src = e.target.result;
          previewImage.style.display = "block";

          previewImage.onload = async () => {
            canvas.width = previewImage.width;
            canvas.height = previewImage.height;

            const poses = await detectPose(previewImage);
            drawPose(poses);
          };
        };

        reader.readAsDataURL(file);
      }
    });
  } catch (error) {
    console.error("Error during initialization:", error);
  }
};
