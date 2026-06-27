# Function List Only (JS)

Scope file yang dipakai: [src/views/AttendanceView.jsx](src/views/AttendanceView.jsx#L1), [src/views/TasksView.jsx](src/views/TasksView.jsx#L1), [src/views/ContributionsView.jsx](src/views/ContributionsView.jsx#L1), [src/views/DashboardView.jsx](src/views/DashboardView.jsx#L1).

## 1) IoT Attendance + Geolocation

Source: [src/views/AttendanceView.jsx](src/views/AttendanceView.jsx#L1)

- [parseStoredDescriptor](src/views/AttendanceView.jsx#L78)
- [detectFaceFromImage](src/views/AttendanceView.jsx#L140)
- [cropFaceCanvas](src/views/AttendanceView.jsx#L187)
- [ensureYoloFaceDetector](src/views/AttendanceView.jsx#L210)
- [getDistanceFromLatLonInMeters](src/views/AttendanceView.jsx#L574)
- [getFaceOverlayStyle](src/views/AttendanceView.jsx#L591)
- [handleClockIn](src/views/AttendanceView.jsx#L655)

## 2) Kanban with Extended dan Revision Deadline

Source: [src/views/TasksView.jsx](src/views/TasksView.jsx#L1)

- [handleApproveTask](src/views/TasksView.jsx#L234)
- [handleStatusChange](src/views/TasksView.jsx#L357)

## 3) Discussion Board

Source: [src/views/ContributionsView.jsx](src/views/ContributionsView.jsx#L1)

- [handleSendReply](src/views/ContributionsView.jsx#L101)

## 4) Dashboard Overview

Source: [src/views/DashboardView.jsx](src/views/DashboardView.jsx#L1)

- [processChartData](src/views/DashboardView.jsx#L86)

## 5) Penilaian

- Tidak termasuk dalam 3 file scope saat ini.

## 6) Copy-Paste Lanjutan Section 1.1 (Function Inti)

### **Function 0: Stored Descriptor Hydration for Face Matching**

* **Scope File:** [src/views/AttendanceView.jsx](src/views/AttendanceView.jsx#L1)

```javascript
const parseStoredDescriptor = (value) => {
	if (!value) return null;

	let parsed = value;
	if (typeof value === 'string') {
		try {
			parsed = JSON.parse(value);
		} catch {
			return null;
		}
	}

	if (Array.isArray(parsed)) return new Float32Array(parsed);
	if (parsed && Array.isArray(parsed.data)) return new Float32Array(parsed.data);
	return null;
};
```

The `parseStoredDescriptor` function converts stored face descriptor payloads back into a Float32Array so the recognition pipeline can compare embeddings on the client side. It accepts either a JSON string or a structured object and returns `null` when the stored value is not usable.

### **Function 1: Edge Node Image Stream Cropping and Memory Release**

* **Scope File:** [src/views/AttendanceView.jsx](src/views/AttendanceView.jsx#L1)

```javascript
const cropFaceCanvas = (sourceCanvas, box) => {
	if (!sourceCanvas || !box) return null;

	const x = Math.max(0, Math.floor(box.xmin ?? box.x ?? 0));
	const y = Math.max(0, Math.floor(box.ymin ?? box.y ?? 0));
	const width = Math.max(1, Math.floor(box.width ?? ((box.xmax ?? 0) - (box.xmin ?? 0))));
	const height = Math.max(1, Math.floor(box.height ?? ((box.ymax ?? 0) - (box.ymin ?? 0))));
	const safeWidth = Math.min(width, sourceCanvas.width - x);
	const safeHeight = Math.min(height, sourceCanvas.height - y);

	if (safeWidth <= 1 || safeHeight <= 1) return null;

	const cropCanvas = document.createElement('canvas');
	cropCanvas.width = safeWidth;
	cropCanvas.height = safeHeight;

	const cropContext = cropCanvas.getContext('2d');
	if (!cropContext) return null;

	cropContext.drawImage(sourceCanvas, x, y, safeWidth, safeHeight, 0, 0, safeWidth, safeHeight);
	return cropCanvas;
};
```

The `cropFaceCanvas` procedure extracts only the detected face area from the source canvas. It clamps the crop bounds so the operation stays inside the image frame and returns the cropped canvas for the next recognition step.

### **Function 2: Face Detection Pipeline Bootstrap**

* **Scope File:** [src/views/AttendanceView.jsx](src/views/AttendanceView.jsx#L1)

```javascript
const detectFaceFromImage = async (imageEl) => {
	if (!imageEl || !imageEl.complete || imageEl.naturalWidth === 0) return null;

	const sourceCanvas = document.createElement('canvas');
	sourceCanvas.width = imageEl.naturalWidth;
	sourceCanvas.height = imageEl.naturalHeight;
	const sourceContext = sourceCanvas.getContext('2d');

	if (!sourceContext) return null;

	sourceContext.drawImage(imageEl, 0, 0, sourceCanvas.width, sourceCanvas.height);

	try {
		const detector = await ensureYoloFaceDetector();
		const detections = await detector(imageEl, { threshold: YOLO_FACE_THRESHOLD });
		const bestDetection = detections
			.filter((entry) => String(entry.label || '').toLowerCase().includes('face') || !entry.label)
			.sort((a, b) => (b.score || 0) - (a.score || 0))[0] || detections.sort((a, b) => (b.score || 0) - (a.score || 0))[0];

		if (bestDetection?.box) {
			const cropCanvas = cropFaceCanvas(sourceCanvas, bestDetection.box);
			if (cropCanvas) {
				const croppedDetection = await detectWithFaceApi(cropCanvas);

				if (croppedDetection) {
					return {
						...croppedDetection,
						source: 'yolo',
						box: normalizeBoundingBox(bestDetection.box),
					};
				}
			}
		}
	} catch (error) {
		console.warn('YOLO face detector fallback to face-api full frame:', error);
	}

	const fallbackDetection = await detectWithFaceApi(sourceCanvas);
	if (!fallbackDetection) return null;

	return {
		...fallbackDetection,
		source: 'faceapi',
		box: normalizeBoundingBox(fallbackDetection.detection?.box),
	};
};
```

The `detectFaceFromImage` function coordinates the face detection flow by preparing a source canvas, running YOLO detection, and falling back to face-api when needed. It acts as the bootstrap for image-based face verification before the attendance transaction is allowed to continue.

### **Function 3: YOLO Face Detector Initialization**

* **Scope File:** [src/views/AttendanceView.jsx](src/views/AttendanceView.jsx#L1)

```javascript
const ensureYoloFaceDetector = async () => {
	if (yoloDetectorRef.current) return yoloDetectorRef.current;

	if (!yoloDetectorPromiseRef.current) {
		yoloDetectorPromiseRef.current = pipeline('object-detection', YOLO_FACE_MODEL_ID)
			.then((detector) => {
				yoloDetectorRef.current = detector;
				return detector;
			})
			.catch((error) => {
				yoloDetectorPromiseRef.current = null;
				throw error;
			});
	}

	return yoloDetectorPromiseRef.current;
};
```

The `ensureYoloFaceDetector` function lazily initializes the YOLO face detection model and reuses the cached instance for later requests. This reduces repeated model loading and keeps the detection flow responsive.

### **Function 4: Geofence Overlay Alignment Helper**

* **Scope File:** [src/views/AttendanceView.jsx](src/views/AttendanceView.jsx#L1)

```javascript
const getFaceOverlayStyle = () => {
	if (!faceOverlayBox || !esp32CamImageRef.current) return null;

	const imageEl = esp32CamImageRef.current;
	const naturalWidth = imageEl.naturalWidth || faceOverlayBox.imageWidth;
	const naturalHeight = imageEl.naturalHeight || faceOverlayBox.imageHeight;
	const viewportWidth = imageEl.clientWidth || 0;
	const viewportHeight = imageEl.clientHeight || 0;

	if (!naturalWidth || !naturalHeight || !viewportWidth || !viewportHeight) return null;

	const naturalRatio = naturalWidth / naturalHeight;
	const viewportRatio = viewportWidth / viewportHeight;

	let displayedWidth = viewportWidth;
	let displayedHeight = viewportHeight;
	let offsetX = 0;
	let offsetY = 0;

	if (viewportRatio > naturalRatio) {
		displayedHeight = viewportHeight;
		displayedWidth = viewportHeight * naturalRatio;
		offsetX = (viewportWidth - displayedWidth) / 2;
	} else {
		displayedWidth = viewportWidth;
		displayedHeight = viewportWidth / naturalRatio;
		offsetY = (viewportHeight - displayedHeight) / 2;
	}

	const scaleX = displayedWidth / naturalWidth;
	const scaleY = displayedHeight / naturalHeight;

	return {
		left: `${offsetX + (faceOverlayBox.x * scaleX)}px`,
		top: `${offsetY + (faceOverlayBox.y * scaleY)}px`,
		width: `${faceOverlayBox.width * scaleX}px`,
		height: `${faceOverlayBox.height * scaleY}px`,
	};
};
```

The `getFaceOverlayStyle` helper converts the detected face box into viewport coordinates so the overlay stays aligned with the camera image. It ensures the visual marker matches the displayed preview even when the aspect ratio changes.

### **Function 5: Biometric Authentication Tracking and Cloud Persistence Ledger**

* **Scope File:** [src/views/AttendanceView.jsx](src/views/AttendanceView.jsx#L1)

```javascript
const handleClockIn = async (source = 'manual') => {
	if (!currentCoords) return alert("Waiting for secure GPS baseline validation coordinates...");
	if (!isInRange) return alert(`Geofence rejection exception: You sit ${liveDistance?.toFixed(0)}m outside office gates.`);
	if (userProfile.role !== 'supervisor' && (!isCameraReady || !isFaceVerified)) return false;

	setIsLoading(true);
	try {
		const now = new Date();
		const time = now.toLocaleTimeString('en-GB', { hour12: false });
		const status = time > WORK_START_TIME ? 'Late' : 'Present';
		const { error } = await supabase.from(ATTENDANCE_TABLE).insert([{
			employee_id: userProfile.id,
			date: today,
			status,
			latitude: currentCoords ? currentCoords.latitude : null,
			longitude: currentCoords ? currentCoords.longitude : null,
		}]);
		if (error) {
			alert('Database submission error: ' + error.message);
			return false;
		}
		setClockInSource(source);
		setClockInAt(time);
		setFaceScannerMessage(
			source === 'face-match'
				? `Face matched. Auto clock-in saved at ${time}.`
				: `Clock-in saved at ${time}.`
		);
		await fetchAttendance();
		return true;
	} finally {
		setIsLoading(false);
	}
};
```

The `handleClockIn` function writes the attendance record to Supabase after GPS and face verification pass. It stores the employee identity, date, status, and coordinates, then refreshes the attendance view.

### **Function 6: Kanban Pipeline with Asynchronous State Mutators**

* **Scope File:** [src/views/TasksView.jsx](src/views/TasksView.jsx#L1)

```javascript
const handleStatusChange = async (taskId, newStatus) => {
	await supabase.from('tasks').update({ status: newStatus }).eq('id', taskId);
	fetchTasks();
};
```

The `handleStatusChange` procedure updates the task status in the remote table and reloads the task list so the Kanban board stays synchronized.

### **Function 7: Discussion Forum Nested Array Data Mutations**

* **Scope File:** [src/views/ContributionsView.jsx](src/views/ContributionsView.jsx#L1)

```javascript
const handleSendReply = async (postId, currentReplies = []) => {
	const cleanReply = sanitizeText(replyInputs[postId], { allowNewlines: true, maxLength: 1000 });
	if (!cleanReply) return;
	const rateLimit = checkRateLimit(`contributions-reply-${postId}`, 5000);
	if (!rateLimit.allowed) {
		alert(formatRateLimitMessage(rateLimit.retryAfterMs));
		return;
	}
	setSubmittingReplyId(postId);
	const nextReplyObject = {
		id: `reply-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
		author_id: userProfile.id,
		message: cleanReply,
		timestamp: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
	};
	const updatedRepliesArray = [...currentReplies, nextReplyObject];
	const { error } = await supabase
		.from('contributions')
		.update({ replies: updatedRepliesArray })
		.eq('id', postId);
	if (error) {
		alert("Failed to submit reply: " + error.message);
	} else {
		setReplyInputs(prev => ({ ...prev, [postId]: '' }));
		fetchContributions();
	}
	setSubmittingReplyId(null);
};
```

The `handleSendReply` framework method adds a sanitized reply to the existing discussion array, applies a short rate limit, and writes the updated replies back to the database.

### **Function 8: Administrative Review and Roster Grading Mark Calibration**

* **Scope File:** [src/views/TasksView.jsx](src/views/TasksView.jsx#L1)

```javascript
const handleApproveTask = async (task) => {
	const { error } = await supabase
		.from('tasks')
		.update({ status: 'Approved' })
		.eq('id', task.id);

	if (error) {
		alert("Database Error during approval: " + error.message);
	} else {
		(task.assigned_to || []).forEach(async (userId) => {
			await createNotification(userId, `🎉 Task Approved: Your submission for "${task.title}" has been successfully approved!`);
		});
		fetchTasks();
	}
};
```

The `handleApproveTask` routine updates the task status to Approved, notifies the assigned users, and refreshes the task list after the database transaction succeeds.

### **Function 9: Calendar Chart Data Aggregation for Dashboard Insights**

* **Scope File:** [src/views/DashboardView.jsx](src/views/DashboardView.jsx#L1)

```javascript
const processChartData = () => {
	const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun"];
	const users = allUsers.filter(u => u.role === 'employee');
	const attData = [];
	const taskData = [];
	months.forEach((month, index) => {
		const targetMonth = index;
		const attMonth = { name: month };
		const taskMonth = { name: month };
		users.forEach(u => {
			const presentCount = attendance.filter(a =>
				a.employee_id === u.id &&
				new Date(a.date).getMonth() === targetMonth &&
				(a.status === 'Present' || a.status === 'Late')
			).length;
			const completedCount = tasks.filter(t =>
				(t.assigned_to || []).includes(u.id) &&
				t.status === 'Approved' &&
				new Date(t.due_date).getMonth() === targetMonth
			).length;
			if (selectedEmployee === 'all' || selectedEmployee === u.id) {
				attMonth[u.name] = presentCount;
				taskMonth[u.name] = completedCount;
			}
		});
		attData.push(attMonth);
		taskData.push(taskMonth);
	});

	return { attData, taskData };
};
```

The `processChartData` function aggregates monthly attendance and task completion data for dashboard charts. It groups employee records by month, counts valid attendance entries and approved task completions, then returns the prepared arrays used by the chart rendering layer. This keeps the dashboard analytics aligned with the filtered employee selection.

---

### Cara Copypaste Paling Rapi di Word:

1. Tempel blok kode ke Word lalu biarkan tampil sebagai kotak teks atau tabel 1 kolom supaya struktur kode tetap rapi.
2. Taruh paragraf penjelasan di bawah kotak kode, lalu blok paragraf tersebut dan set ke Justify serta Double Spacing.

---

## 7) Copy-Paste Hardware IoT Section (ESP32 Implementation)

### **Function 10: MJPEG Live Stream Handler with CORS Proxy Layer**

* **Scope File:** `ARDUINO/ESP32_Absensi_Cam/src/main.cpp`

```cpp
static esp_err_t stream_handler(httpd_req_t *req) {
  camera_fb_t *fb = NULL;
  esp_err_t res = ESP_OK;
  size_t _jpg_buf_len = 0;
  uint8_t *_jpg_buf = NULL;
  char part_buf[64];
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  httpd_resp_set_hdr(req, "Access-Control-Allow-Methods", "GET, OPTIONS");
  httpd_resp_set_hdr(req, "Access-Control-Allow-Headers", "*");
  res = httpd_resp_set_type(req, _STREAM_CONTENT_TYPE);
  if (res != ESP_OK) return res;
  while (true) {
    fb = esp_camera_fb_get();
    if (!fb) {
      Serial.println("Camera capture failed");
      res = ESP_FAIL;
    } else {
      _jpg_buf_len = fb->len;
      _jpg_buf = fb->buf;
    }
    if (res == ESP_OK) {
      size_t hlen = snprintf(part_buf, sizeof(part_buf), _STREAM_PART, _jpg_buf_len);
      res = httpd_resp_send_chunk(req, part_buf, hlen);
    }
    if (res == ESP_OK) {
      res = httpd_resp_send_chunk(req, (const char *)_jpg_buf, _jpg_buf_len);
    }
    if (res == ESP_OK) {
      res = httpd_resp_send_chunk(req, _STREAM_BOUNDARY, strlen(_STREAM_BOUNDARY));
    }
    if (fb) {
      esp_camera_fb_return(fb);
      fb = NULL;
      _jpg_buf = NULL;
    } else if (_jpg_buf) {
      free(_jpg_buf);
      _jpg_buf = NULL;
    }
    if (res != ESP_OK) break;
  }
  return res;
}
```

The `stream_handler` function implements a continuous MJPEG stream endpoint on the embedded HTTP server. It captures frames from the OV2640 camera module, wraps each JPEG frame in a multipart boundary chunk, and sends the stream directly to the requesting client. The CORS headers enable cross-origin requests so the React frontend can pull the live feed without permission errors.

### **Function 11: HTTP Server Bootstrap and Camera Initialization**

* **Scope File:** `ARDUINO/ESP32_Absensi_Cam/src/main.cpp`

```cpp
void startCameraServer() {
  httpd_config_t config = HTTPD_DEFAULT_CONFIG();
  config.server_port = 81;
  httpd_uri_t stream_uri = {
    .uri       = "/stream",
    .method    = HTTP_GET,
    .handler   = stream_handler,
    .user_ctx  = NULL
  };
  if (httpd_start(&stream_httpd, &config) == ESP_OK) {
    httpd_register_uri_handler(stream_httpd, &stream_uri);
  }
}
void setup() {
  Serial.begin(115200);
  Serial.setDebugOutput(false);
  camera_config_t config;
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer = LEDC_TIMER_0;
  config.pin_d0 = Y2_GPIO_NUM;
  config.pin_d1 = Y3_GPIO_NUM;
  config.pin_d2 = Y4_GPIO_NUM;
  config.pin_d3 = Y5_GPIO_NUM;
  config.pin_d4 = Y6_GPIO_NUM;
  config.pin_d5 = Y7_GPIO_NUM;
  config.pin_d6 = Y8_GPIO_NUM;
  config.pin_d7 = Y9_GPIO_NUM;
  config.pin_xclk = XCLK_GPIO_NUM;
  config.pin_pclk = PCLK_GPIO_NUM;
  config.pin_vsync = VSYNC_GPIO_NUM;
  config.pin_href = HREF_GPIO_NUM;
  config.pin_sscb_sda = SIOD_GPIO_NUM;
  config.pin_sscb_scl = SIOC_GPIO_NUM;
  config.pin_pwdn = PWDN_GPIO_NUM;
  config.pin_reset = RESET_GPIO_NUM;
  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXFORMAT_JPEG;
  if(psramFound()){
    config.frame_size = FRAMESIZE_VGA;
    config.jpeg_quality = 10;
    config.fb_count = 2;
  } else {
    config.frame_size = FRAMESIZE_SVGA;
    config.jpeg_quality = 12;
    config.fb_count = 1;
  }
  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.printf("Camera init failed with error 0x%x", err);
    return;
  }
  WiFi.begin(ssid, password);
}
```

The `setup()` function initializes the camera hardware interface by configuring all GPIO pins for the OV2640 module, setting JPEG quality and frame buffer count based on PSRAM availability, and launching the HTTP server on port 81. This establishes the embedded web server that streams video to the frontend application.

### **Function 12: Ultrasonic Distance Sensor Acquisition and Trigger Logic**

* **Scope File:** `ARDUINO/ESP32_Master_Absensi/src/main.cpp`

```cpp
void loop() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);
  duration = pulseIn(ECHO_PIN, HIGH, 30000);
  if (duration == 0) {
    Serial.println("Jarak Object: timeout");
    digitalWrite(TRIGGER_OUT_PIN, LOW);
    delay(500);
    return;
  }
  distance = duration * 0.034 / 2;
  Serial.print("Jarak Object: ");
  Serial.print(distance);
  Serial.println(" cm");
  if (distance > 0 && distance <= 50) {
    Serial.println(">>> ADA ORANG! Bangunin ESP32-CAM! <<<");
    digitalWrite(TRIGGER_OUT_PIN, HIGH);
    delay(5000);
  } else {
    digitalWrite(TRIGGER_OUT_PIN, LOW);
  }
  delay(500);
}
```

The `loop()` function implements the ultrasonic measurement pipeline by sending a trigger pulse, measuring the echo duration, and converting it to distance in centimeters using the speed of sound. When an object is detected within 50 cm, it sends a HIGH signal to the ESP32-CAM board to activate the camera stream. This proximity trigger prevents unnecessary streaming when no person is present at the attendance station.

---

### Cara Copypaste Hardware Section di Word:

Sama seperti Software section: tempel blok kode ke kotak teks, taruh paragraf penjelasan di bawah, lalu set ke Justify + Double Spacing.
