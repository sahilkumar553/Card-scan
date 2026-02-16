    let activeSessionId = null;
    let pollHandle = null;

    function isMobileDevice() {
      const userAgent = navigator.userAgent || navigator.vendor || window.opera || '';
      const mobileUaPattern = /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini|mobile/i;
      const hasTouchScreen = navigator.maxTouchPoints > 1;
      const smallScreen = window.matchMedia('(max-width: 900px)').matches;
      return mobileUaPattern.test(userAgent) || (hasTouchScreen && smallScreen);
    }

    function setStatus(text, isError = false) {
      $('#desktopStatus').text(text).toggleClass('error', isError);
    }

    function showDesktopSuccessTick() {
      $('#desktopSuccessTick').removeClass('hidden');
    }

    function hideDesktopSuccessTick() {
      $('#desktopSuccessTick').addClass('hidden');
    }

    function normalizeCardNumber(value) {
      return (value || '').replace(/\D/g, '').slice(0, 16);
    }

    function formatCardNumber(number) {
      return normalizeCardNumber(number).replace(/(.{4})/g, '$1 ').trim();
    }

    function applyCardType(type) {
      const normalized = (type || 'UNKNOWN').toUpperCase();
      const badge = $('#cardTypeBadge');
      const icon = $('#cardTypeIcon');
      const text = $('#cardTypeText');
      badge.removeClass('visa mastercard rupay amex discover unknown');

      const iconMap = {
        VISA: '/assets/visa.svg',
        MASTERCARD: '/assets/mastercard.svg',
        RUPAY: '/assets/rupay.svg'
      };

      if (normalized === 'VISA') badge.addClass('visa');
      else if (normalized === 'MASTERCARD') badge.addClass('mastercard');
      else if (normalized === 'RUPAY') badge.addClass('rupay');
      else if (normalized === 'AMEX') badge.addClass('amex');
      else if (normalized === 'DISCOVER') badge.addClass('discover');
      else badge.addClass('unknown');

      if (iconMap[normalized]) {
        icon.attr('src', iconMap[normalized]).removeClass('hidden');
        text.addClass('hidden').text('');
      } else {
        icon.attr('src', '').addClass('hidden');
        text.addClass('hidden').text('');
      }
    }

    function applyCardData(data) {
      if (!data) return;

      const rawNumber = normalizeCardNumber(data.cardNumber || '');
      const maskedNumber = data.maskedCardNumber || '';
      const displayNumber = rawNumber ? formatCardNumber(rawNumber) : maskedNumber;

      $('#cardNumber').val(displayNumber || '');
      $('#cardholderName').val(data.cardholderName || '');
      $('#expiryDate').val(data.expiryDate || '');
      applyCardType(data.cardType);
    }

    function stopPolling() {
      if (pollHandle) {
        clearInterval(pollHandle);
        pollHandle = null;
      }
    }

    function pollOnce(sessionId) {
      return $.ajax({
        url: '/api/get-data',
        method: 'GET',
        data: { sessionId, _: Date.now() },
        cache: false,
        timeout: 7000
      }).done(function(res) {
        if (!res.ok) return;

        if (res.status === 'pending') {
          setStatus('Waiting for mobile scan...');
          return;
        }

        if (res.status === 'ready' && res.data) {
          applyCardData(res.data);
          setStatus('Card details autofilled successfully.');
          showDesktopSuccessTick();

          $('#qrModal').addClass('hidden');
          stopPolling();
          activeSessionId = null;
        }
      }).fail(function(xhr) {
        const code = xhr.status;
        if (code === 404 || code === 410) {
          setStatus('Session expired. Please scan again.', true);
          stopPolling();
          activeSessionId = null;
        }
      });
    }

    function startPolling(sessionId) {
      stopPolling();
      pollOnce(sessionId);
      pollHandle = setInterval(function() {
        pollOnce(sessionId);
      }, 1500);
    }

    function initAutopollFromQuery() {
      const params = new URLSearchParams(window.location.search);
      const querySessionId = params.get('sessionId');
      const shouldAutopoll = params.get('autopoll') === '1';

      if (!querySessionId || !shouldAutopoll) return;

      activeSessionId = querySessionId;
      hideDesktopSuccessTick();
      $('#qrModal').addClass('hidden');
      setStatus('Checking scanned card data...');
      startPolling(querySessionId);

      const cleanUrl = window.location.pathname;
      window.history.replaceState({}, document.title, cleanUrl);
    }

    $('#openScannerBtn').on('click', function() {
      setStatus('Creating secure scan session...');
      hideDesktopSuccessTick();

      $.ajax({
        url: '/api/session',
        method: 'POST'
      }).done(function(res) {
        if (!res.ok) {
          setStatus('Failed to create scan session.', true);
          return;
        }

        activeSessionId = res.sessionId;

        if (isMobileDevice()) {
          setStatus('Opening mobile camera scanner...');
          window.location.href = res.mobileUrl;
          return;
        }

        $('#qrImage').attr('src', res.qrCode);
        $('#sessionLabel').text('Session: ' + activeSessionId.slice(0, 8) + '...');
        $('#qrModal').removeClass('hidden');
        setStatus('Scan QR from your mobile to continue.');
        startPolling(activeSessionId);
      }).fail(function() {
        setStatus('Could not connect to server.', true);
      });
    });

    $('#closeModalBtn').on('click', function() {
      $('#qrModal').addClass('hidden');
      setStatus('Scanner closed.');
      hideDesktopSuccessTick();
      stopPolling();
      activeSessionId = null;
    });

    $('#cardNumber').on('input', function() {
      $(this).val(formatCardNumber($(this).val()));
    });

    initAutopollFromQuery();
