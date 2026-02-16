
    let streamRef = null;
    let canUseLiveCamera = false;
    let scanningActive = false;
    let uploadInFlight = false;
    let scanIntervalRef = null;
    let hasCompleted = false;
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get('sessionId');
    const returnToRaw = params.get('returnTo');
    const SCAN_INTERVAL_MS = 650;
    const CARD_ASPECT_RATIO = 1.58;
    const MAX_CAPTURE_WIDTH = 960;

    function getSafeReturnUrl() {
      if (!returnToRaw) return '';

      try {
        const parsed = new URL(returnToRaw, window.location.origin);
        if (parsed.origin !== window.location.origin) return '';
        return parsed.toString();
      } catch (_error) {
        return '';
      }
    }

    const returnToUrl = getSafeReturnUrl();

    function setScannerStatus(text, isError = false) {
      $('#scannerStatus').text(text).toggleClass('error', isError);
    }

    async function openCamera() {
      if (!sessionId) {
        setScannerStatus('Invalid scanner session link.', true);
        $('#scanBtn').prop('disabled', true);
        return;
      }

      if (!window.isSecureContext) {
        canUseLiveCamera = false;
        setScannerStatus('Real-time camera requires HTTPS on mobile. Use secure tunnel URL.', true);
        $('#scanBtn').prop('disabled', true);
        return;
      }

      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        canUseLiveCamera = false;
        setScannerStatus('Live camera API not supported on this device.', true);
        $('#scanBtn').prop('disabled', true);
        return;
      }

      try {
        streamRef = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1280 },
            height: { ideal: 720 },
            frameRate: { ideal: 30, max: 30 }
          },
          audio: false
        });

        const video = document.getElementById('video');
        video.srcObject = streamRef;
        canUseLiveCamera = true;
        setScannerStatus('Camera ready. Tap Start Real-Time Scan.');
      } catch (error) {
        canUseLiveCamera = false;
        setScannerStatus('Camera permission denied or unavailable.', true);
        $('#scanBtn').prop('disabled', true);
      }
    }

    function captureFrameBlob() {
      return new Promise((resolve) => {
        const video = document.getElementById('video');
        const canvas = document.getElementById('captureCanvas');
        const frameWidth = video.videoWidth;
        const frameHeight = video.videoHeight;

        if (!frameWidth || !frameHeight) {
          resolve(null);
          return;
        }

        const overlayWidthRatio = 0.86;
        const sourceWidth = Math.floor(frameWidth * overlayWidthRatio);
        const sourceHeight = Math.floor(sourceWidth / CARD_ASPECT_RATIO);
        const safeSourceHeight = Math.min(sourceHeight, frameHeight);
        const safeSourceWidth = Math.min(sourceWidth, Math.floor(safeSourceHeight * CARD_ASPECT_RATIO));
        const sourceX = Math.max(0, Math.floor((frameWidth - safeSourceWidth) / 2));
        const sourceY = Math.max(0, Math.floor((frameHeight - safeSourceHeight) / 2));

        const targetWidth = Math.min(MAX_CAPTURE_WIDTH, safeSourceWidth);
        const targetHeight = Math.floor(targetWidth / CARD_ASPECT_RATIO);

        canvas.width = targetWidth;
        canvas.height = targetHeight;

        const ctx = canvas.getContext('2d');
        ctx.drawImage(
          video,
          sourceX,
          sourceY,
          safeSourceWidth,
          safeSourceHeight,
          0,
          0,
          canvas.width,
          canvas.height
        );

        canvas.toBlob((blob) => resolve(blob), 'image/jpeg', 0.78);
      });
    }

    function uploadBlob(blob) {
      return $.ajax({
        url: '/api/scan',
        method: 'POST',
        data: (function() {
          const formData = new FormData();
          formData.append('sessionId', sessionId);
          formData.append('cardImage', blob, 'card-scan.jpg');
          return formData;
        })(),
        processData: false,
        contentType: false,
        timeout: 15000
      });
    }

    function stopCameraStream() {
      if (streamRef) {
        streamRef.getTracks().forEach((track) => track.stop());
        streamRef = null;
      }
    }

    function stopRealtimeScan() {
      scanningActive = false;
      uploadInFlight = false;
      if (scanIntervalRef) {
        clearInterval(scanIntervalRef);
        scanIntervalRef = null;
      }
      $('#scanLoader').addClass('hidden');
      $('#scanBtn').text('Start Real-Time Scan').prop('disabled', !canUseLiveCamera);
    }

    function handleSuccessfulScan() {
      hasCompleted = true;
      stopRealtimeScan();
      $('#scanSuccess').removeClass('hidden');
      setScannerStatus('Scan successful! Returning to card autofill page...');
      stopCameraStream();

      setTimeout(function() {
        if (returnToUrl) {
          window.location.replace(returnToUrl);
          return;
        }

        window.close();
        $('#scannerSubtitle').text('You can close this page now.');
      }, 1800);
    }

    async function scanOnce() {
      if (!scanningActive || uploadInFlight || hasCompleted) return;
      if (!streamRef || !canUseLiveCamera) return;

      uploadInFlight = true;
      $('#scanLoader').removeClass('hidden');

      try {
        const blob = await captureFrameBlob();
        if (!blob) {
          setScannerStatus('Could not read camera frame. Keep card steady.', true);
          return;
        }

        const res = await uploadBlob(blob);
        if (res?.ok) {
          handleSuccessfulScan();
          return;
        }
      } catch (error) {
        const status = error?.status;
        const message = error?.responseJSON?.error;

        if (status === 422) {
          setScannerStatus('Reading card... adjust angle and lighting.');
        } else if (status === 404 || status === 410) {
          setScannerStatus('Session expired. Please rescan QR from desktop.', true);
          stopRealtimeScan();
          return;
        } else {
          setScannerStatus(message || 'Scan in progress... keep card inside frame.');
        }
      } finally {
        uploadInFlight = false;
        if (!hasCompleted) {
          $('#scanLoader').addClass('hidden');
        }
      }
    }

    function startRealtimeScan() {
      if (!canUseLiveCamera || !streamRef) {
        setScannerStatus('Live camera is not ready.', true);
        return;
      }

      scanningActive = true;
      hasCompleted = false;
      $('#scanSuccess').addClass('hidden');
      $('#scanBtn').text('Stop Scan').prop('disabled', false);
      setScannerStatus('Scanning continuously... hold card inside frame.');

      scanIntervalRef = setInterval(scanOnce, SCAN_INTERVAL_MS);
      scanOnce();
    }

    $('#scanBtn').on('click', function() {
      if (scanningActive) {
        stopRealtimeScan();
        setScannerStatus('Real-time scan paused.');
        return;
      }

      startRealtimeScan();
    });

    window.addEventListener('beforeunload', function() {
      stopRealtimeScan();
      stopCameraStream();
    });

    openCamera();