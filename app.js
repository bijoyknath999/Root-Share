(function () {
  var $ = function(s) { return document.querySelector(s); };
  var READ_SIZE = 2097152;
  var SEND_SIZE = 262144;
  var BUFFER_LIMIT = 4194304;
  var ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ];

  var firebaseConfig = {
    apiKey: "AIzaSyAmok3gW_5CWDwDfI323uW0GGgV5-WYe9c",
    authDomain: "root-share-app.firebaseapp.com",
    databaseURL: "https://root-share-app-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "root-share-app",
    storageBucket: "root-share-app.firebasestorage.app",
    messagingSenderId: "842885517531",
    appId: "1:842885517531:web:84613e37a51d1ac5aabcfe"
  };

  firebase.initializeApp(firebaseConfig);
  var db = firebase.database();

  var peerConnection = null;
  var dataChannel = null;
  var currentRoom = null;
  var isInitiator = false;
  var queuedFiles = [];
  var isConnected = false;
  var receivedBuffers = [];
  var receivedSize = 0;
  var totalReceiveSize = 0;
  var lastReceiveProgressUpdate = 0;

  function generateRoomCode() {
    var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    var code = '';
    for (var i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return code;
  }

  function formatSize(bytes) {
    if (!bytes) return '0 B';
    var k = 1024;
    var sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    var i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  function showToast(msg, type) {
    type = type || 'info';
    var t = document.createElement('div');
    t.className = 'toast ' + type;
    t.textContent = msg;
    $('#toastContainer').appendChild(t);
    setTimeout(function() { if (t.parentNode) t.remove(); }, 3000);
  }

  function setStatus(text, state) {
    state = state || '';
    var dot = $('.status-dot');
    var txt = $('.status-text');
    if (!dot || !txt) return;
    dot.className = 'status-dot' + (state ? ' ' + state : '');
    txt.textContent = text;
  }

  function initTheme() {
    var saved = localStorage.getItem('rootshare-theme');
    if (saved === 'light') document.documentElement.setAttribute('data-theme', 'light');
    updateThemeIcon();
  }

  function toggleTheme() {
    var isLight = document.documentElement.getAttribute('data-theme') === 'light';
    if (isLight) {
      document.documentElement.removeAttribute('data-theme');
      localStorage.setItem('rootshare-theme', 'dark');
    } else {
      document.documentElement.setAttribute('data-theme', 'light');
      localStorage.setItem('rootshare-theme', 'light');
    }
    updateThemeIcon();
  }

  function updateThemeIcon() {
    var isLight = document.documentElement.getAttribute('data-theme') === 'light';
    $('#sunIcon').style.display = isLight ? 'none' : 'block';
    $('#moonIcon').style.display = isLight ? 'block' : 'none';
  }

  function showQRModal() {
    var code = $('#roomCodeDisplay').textContent;
    if (!code) return;
    var url = getShareUrl(code);
    var qrApi = 'https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=' + encodeURIComponent(url);

    var overlay = document.createElement('div');
    overlay.id = 'qrModalOverlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;padding:20px;';

    var box = document.createElement('div');
    box.style.cssText = 'background:var(--bg-secondary);border:1px solid var(--border);border-radius:16px;padding:28px;max-width:360px;width:100%;text-align:center;position:relative;box-shadow:0 8px 32px rgba(0,0,0,0.4);';

    var closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.style.cssText = 'position:absolute;top:10px;right:10px;background:none;border:none;color:var(--text-secondary);cursor:pointer;padding:4px;font-size:20px;line-height:1;';
    closeBtn.onclick = function() { document.body.removeChild(overlay); };

    var h2 = document.createElement('h2');
    h2.textContent = 'Scan to Connect';
    h2.style.cssText = 'font-size:1.1rem;margin-bottom:6px;';

    var desc = document.createElement('p');
    desc.textContent = 'Open camera and scan this QR code';
    desc.style.cssText = 'color:var(--text-secondary);font-size:0.82rem;margin-bottom:16px;';

    var qrDiv = document.createElement('div');
    qrDiv.style.cssText = 'margin:0 auto 12px;display:flex;justify-content:center;';
    qrDiv.innerHTML = '<img src="' + qrApi + '" alt="QR Code" width="250" height="250" style="border-radius:12px;background:#fff;padding:8px;">';

    var linkDiv = document.createElement('div');
    linkDiv.textContent = url;
    linkDiv.style.cssText = 'font-size:0.7rem;color:var(--text-muted);word-break:break-all;margin-bottom:14px;font-family:monospace;';

    var copyBtn = document.createElement('button');
    copyBtn.textContent = 'Copy Link';
    copyBtn.className = 'btn btn-primary';
    copyBtn.style.cssText = 'width:100%;';
    copyBtn.onclick = function() {
      navigator.clipboard.writeText(url).then(function() { showToast('Link copied!', 'success'); });
    };

    box.appendChild(closeBtn);
    box.appendChild(h2);
    box.appendChild(desc);
    box.appendChild(qrDiv);
    box.appendChild(linkDiv);
    box.appendChild(copyBtn);
    overlay.appendChild(box);

    overlay.addEventListener('click', function(e) {
      if (e.target === overlay) document.body.removeChild(overlay);
    });

    document.body.appendChild(overlay);
  }

  function getShareUrl(code) {
    return location.origin + location.pathname + '#' + code;
  }

  function checkUrlForRoom() {
    var hash = location.hash.replace('#', '').toUpperCase().trim();
    if (hash && hash.length === 6) {
      setTimeout(function() { joinRoom(hash); }, 500);
    }
  }

  function createPeerConnection() {
    peerConnection = new RTCPeerConnection({
      iceServers: ICE_SERVERS,
      iceCandidatePoolSize: 10,
      iceTransportPolicy: 'all',
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require'
    });

    peerConnection.onicecandidate = function(e) {
      if (e.candidate && currentRoom) {
        var ref = db.ref('rooms/' + currentRoom + '/' + (isInitiator ? 'offerCandidates' : 'answerCandidates'));
        ref.push(e.candidate.toJSON());
      }
    };

    peerConnection.onconnectionstatechange = function() {
      var state = peerConnection.connectionState;
      if (state === 'connected') {
        isConnected = true;
        setStatus('Connected', 'connected');
        sendQueuedFiles();
      } else if (state === 'disconnected' || state === 'failed') {
        isConnected = false;
        setStatus('Disconnected', 'error');
        showToast('Peer disconnected', 'error');
      }
    };

    if (isInitiator) {
      dataChannel = peerConnection.createDataChannel('fileTransfer');
      dataChannel.bufferedAmountLowThreshold = BUFFER_LIMIT;
      setupDataChannel(dataChannel);
    } else {
      peerConnection.ondatachannel = function(e) {
        dataChannel = e.channel;
        dataChannel.bufferedAmountLowThreshold = BUFFER_LIMIT;
        setupDataChannel(dataChannel);
      };
    }

    return peerConnection;
  }

  function setupDataChannel(channel) {
    channel.binaryType = 'arraybuffer';

    channel.onopen = function() {
      isConnected = true;
      setStatus('Connected', 'connected');
      showToast('Connected!', 'success');
      sendQueuedFiles();
    };

    channel.onclose = function() {
      isConnected = false;
      setStatus('Channel closed', 'error');
    };

    channel.onerror = function(e) {
      console.error('DataChannel error:', e);
    };

    channel.onmessage = function(e) {
      if (typeof e.data === 'string') {
        try { handleSignalingMessage(JSON.parse(e.data)); } catch(err) {}
      } else {
        handleFileChunk(e.data);
      }
    };
  }

  function handleSignalingMessage(msg) {
    if (msg.type === 'file-start') {
      receivedBuffers = [];
      receivedSize = 0;
      totalReceiveSize = msg.size || 0;
      lastReceiveProgressUpdate = 0;
      addTransferItem(msg.name, msg.size, 'receiving');
    } else if (msg.type === 'file-end') {
      completeReceive(msg.name, msg.size, msg.mime);
    }
  }

  function handleFileChunk(chunk) {
    receivedBuffers.push(chunk);
    receivedSize += chunk.byteLength;
    var now = Date.now();
    if (now - lastReceiveProgressUpdate > 250 || receivedSize >= totalReceiveSize) {
      updateProgress(receivedSize, totalReceiveSize, 'receiving');
      lastReceiveProgressUpdate = now;
    }
  }

  function completeReceive(name, size, mime) {
    var blob = new Blob(receivedBuffers, { type: mime || 'application/octet-stream' });
    receivedBuffers = [];
    receivedSize = 0;

    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(function() {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);

    markTransferDone(name);
    showToast('Received: ' + name, 'success');
  }

  function addFilesToQueue(files) {
    if (!files || files.length === 0) return;
    for (var i = 0; i < files.length; i++) {
      queuedFiles.push(files[i]);
    }
    updateQueueDisplay();
    showToast(files.length + ' file(s) queued', 'info');
    if (isConnected) sendQueuedFiles();
  }

  async function sendQueuedFiles() {
    if (!isConnected || queuedFiles.length === 0) return;
    var toSend = queuedFiles.slice();
    queuedFiles = [];
    updateQueueDisplay();
    for (var i = 0; i < toSend.length; i++) {
      await sendFile(toSend[i]);
    }
  }

  function updateQueueDisplay() {
    var zone = $('#uploadZone');
    if (!zone) return;
    var count = queuedFiles.length;
    var h2 = zone.querySelector('h2');
    var p = zone.querySelector('p');
    if (count > 0) {
      var totalSize = 0;
      for (var i = 0; i < queuedFiles.length; i++) totalSize += queuedFiles[i].size;
      h2.textContent = count + ' file' + (count > 1 ? 's' : '') + ' ready';
      p.textContent = formatSize(totalSize) + (isConnected ? ' • Sending...' : ' • Waiting for peer...');
    } else {
      h2.textContent = 'Drop files here';
      p.textContent = 'or click to browse • Any file size';
    }
  }

  function sendFile(file) {
    return new Promise(function(resolve) {
      if (!dataChannel || dataChannel.readyState !== 'open') {
        queuedFiles.push(file);
        updateQueueDisplay();
        resolve();
        return;
      }

      dataChannel.send(JSON.stringify({
        type: 'file-start',
        name: file.name,
        size: file.size,
        mime: file.type
      }));

      addTransferItem(file.name, file.size, 'sending');

      var fileOffset = 0;
      var lastProgressUpdate = 0;

      function readNextSlice() {
        if (fileOffset >= file.size) {
          dataChannel.send(JSON.stringify({
            type: 'file-end',
            name: file.name,
            size: file.size,
            mime: file.type
          }));
          markTransferDone(file.name);
          showToast('Sent: ' + file.name, 'success');
          resolve();
          return;
        }

        var end = Math.min(fileOffset + READ_SIZE, file.size);
        var slice = file.slice(fileOffset, end);
        var reader = new FileReader();
        reader.onload = function(e) {
          sendBuffer(e.target.result, 0);
        };
        reader.onerror = function() {
          showToast('Read error', 'error');
          resolve();
        };
        reader.readAsArrayBuffer(slice);
      }

      function sendBuffer(buffer, pos) {
        while (pos < buffer.byteLength) {
          if (!dataChannel || dataChannel.readyState !== 'open') {
            showToast('Connection lost — try again', 'error');
            resolve();
            return;
          }

          if (dataChannel.bufferedAmount > BUFFER_LIMIT) {
            var remaining = buffer.slice(pos);
            dataChannel.onbufferedamountlow = function() {
              dataChannel.onbufferedamountlow = null;
              if (dataChannel && dataChannel.readyState === 'open') {
                sendBuffer(remaining, 0);
              } else {
                resolve();
              }
            };
            return;
          }

          var chunk = buffer.slice(pos, pos + SEND_SIZE);
          try {
            dataChannel.send(chunk);
          } catch (err) {
            showToast('Send error — retrying', 'error');
            setTimeout(function() { resolve(); }, 500);
            return;
          }
          pos += SEND_SIZE;
          fileOffset += chunk.byteLength;
        }

        var now = Date.now();
        if (now - lastProgressUpdate > 250) {
          updateProgress(fileOffset, file.size, 'sending');
          lastProgressUpdate = now;
        }

        readNextSlice();
      }

      readNextSlice();
    });
  }

  function addTransferItem(name, size, direction) {
    var list = $('#transferList');
    var item = document.createElement('div');
    item.className = 'transfer-item';
    item.dataset.name = name;
    item.dataset.direction = direction;
    var statusClass = direction === 'sending' ? 'sending' : 'receiving';
    var statusText = direction === 'sending' ? 'Sending...' : 'Receiving...';
    var fillClass = direction === 'receiving' ? ' receiving' : '';
    item.innerHTML =
      '<div class="transfer-header">' +
        '<span class="transfer-name">' + name + '</span>' +
        '<span class="transfer-status ' + statusClass + '">' + statusText + '</span>' +
      '</div>' +
      '<div class="transfer-progress">' +
        '<div class="progress-bar"><div class="progress-fill' + fillClass + '" style="width:0%"></div></div>' +
        '<div class="transfer-details">' +
          '<span class="transfer-sent">0 B</span>' +
          '<span class="transfer-total">' + formatSize(size) + '</span>' +
        '</div>' +
      '</div>';
    list.prepend(item);
  }

  function updateProgress(current, total, direction) {
    var items = document.querySelectorAll('.transfer-item');
    for (var i = 0; i < items.length; i++) {
      if (items[i].dataset.direction === direction) {
        var pct = total ? Math.round((current / total) * 100) : 0;
        items[i].querySelector('.progress-fill').style.width = pct + '%';
        items[i].querySelector('.transfer-sent').textContent = formatSize(current);
        break;
      }
    }
  }

  function markTransferDone(name) {
    var items = document.querySelectorAll('.transfer-item');
    for (var i = 0; i < items.length; i++) {
      if (items[i].dataset.name === name) {
        var status = items[i].querySelector('.transfer-status');
        status.textContent = '✓ Done';
        status.className = 'transfer-status done';
        items[i].querySelector('.progress-fill').style.width = '100%';
        break;
      }
    }
  }

  function createRoom() {
    var code = generateRoomCode();
    currentRoom = code;
    isInitiator = true;
    createPeerConnection();

    peerConnection.createOffer().then(function(offer) {
      return peerConnection.setLocalDescription(offer);
    }).then(function() {
      var roomRef = db.ref('rooms/' + code);
      return roomRef.set({ 
        offer: { type: peerConnection.localDescription.type, sdp: peerConnection.localDescription.sdp },
        createdAt: Date.now(),
        lastActive: Date.now()
      });
    }).then(function() {
      var roomRef = db.ref('rooms/' + code);
      roomRef.child('answer').on('value', function(snap) {
        var answer = snap.val();
        if (answer && peerConnection && !peerConnection.currentRemoteDescription) {
          peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
        }
      });
      roomRef.child('answerCandidates').on('child_added', function(snap) {
        var candidate = new RTCIceCandidate(snap.val());
        if (peerConnection) peerConnection.addIceCandidate(candidate);
      });
      // Update lastActive periodically
      var heartbeatInterval = setInterval(function() {
        if (currentRoom === code) {
          db.ref('rooms/' + code + '/lastActive').set(Date.now());
        } else {
          clearInterval(heartbeatInterval);
        }
      }, 10000);
      showRoomInfo(code);
      showToast('Room: ' + code, 'success');
    }).catch(function(err) {
      showToast('Error creating room', 'error');
    });
  }

  function listenForActiveRooms() {
    var roomsRef = db.ref('rooms');
    roomsRef.on('value', function(snap) {
      var roomsData = snap.val();
      var activeRoomsList = $('#activeRoomsList');
      var radarDots = $('#radarDots');
      activeRoomsList.innerHTML = '';
      radarDots.innerHTML = '';
      
      if (!roomsData) {
        activeRoomsList.innerHTML = '<div class="no-rooms">No active rooms</div>';
        return;
      }

      var now = Date.now();
      var hasActiveRooms = false;
      var index = 0;
      
      for (var code in roomsData) {
        var room = roomsData[code];
        // Show rooms that were active in the last 5 minutes
        if (room.lastActive && (now - room.lastActive < 5 * 60 * 1000) && room.offer) {
          hasActiveRooms = true;
          
          // Add room item to list
          var roomItem = document.createElement('button');
          roomItem.className = 'active-room-item btn btn-secondary';
          roomItem.innerHTML = '<span class="room-code">' + code + '</span><span class="room-status">Active</span>';
          roomItem.addEventListener('click', function(roomCode) {
            return function() {
              joinRoom(roomCode);
            };
          }(code));
          activeRoomsList.appendChild(roomItem);
          
          // Add radar dot with random position
          var dot = document.createElement('div');
          dot.className = 'radar-dot';
          // Calculate random position within radar (25% to 90% from center)
          var angle = (index * 137.5) * (Math.PI / 180); // Golden angle for even distribution
          var radius = 25 + (index % 3) * 25; // 25%, 50%, 75% radius
          var x = 50 + radius * Math.cos(angle);
          var y = 50 + radius * Math.sin(angle);
          dot.style.left = x + '%';
          dot.style.top = y + '%';
          dot.style.animationDelay = (index * 0.2) + 's';
          radarDots.appendChild(dot);
          
          index++;
        }
      }

      if (!hasActiveRooms) {
        activeRoomsList.innerHTML = '<div class="no-rooms">No active rooms</div>';
      }
    });
  }

  function joinRoom(code) {
    code = code.toUpperCase().trim();
    if (code.length !== 6) {
      showToast('Enter a 6-character code', 'error');
      return;
    }

    currentRoom = code;
    isInitiator = false;

    var roomRef = db.ref('rooms/' + code);
    roomRef.once('value').then(function(snap) {
      var roomData = snap.val();
      if (!roomData || !roomData.offer) {
        showToast('Room not found', 'error');
        return;
      }

      // Update lastActive
      db.ref('rooms/' + code + '/lastActive').set(Date.now());
      
      createPeerConnection();
      return peerConnection.setRemoteDescription(new RTCSessionDescription(roomData.offer));
    }).then(function() {
      return peerConnection.createAnswer();
    }).then(function(answer) {
      return peerConnection.setLocalDescription(answer);
    }).then(function() {
      return db.ref('rooms/' + currentRoom + '/answer').set({
        type: peerConnection.localDescription.type,
        sdp: peerConnection.localDescription.sdp
      });
    }).then(function() {
      // Update lastActive periodically for joiner too
      var heartbeatInterval = setInterval(function() {
        if (currentRoom === code) {
          db.ref('rooms/' + code + '/lastActive').set(Date.now());
        } else {
          clearInterval(heartbeatInterval);
        }
      }, 10000);
      
      db.ref('rooms/' + currentRoom + '/offerCandidates').on('child_added', function(snap) {
        var candidate = new RTCIceCandidate(snap.val());
        if (peerConnection) peerConnection.addIceCandidate(candidate);
      });
      showRoomInfo(currentRoom);
      showToast('Joined: ' + currentRoom, 'success');
    }).catch(function(err) {
      showToast('Error joining room', 'error');
    });
  }

  function showRoomInfo(code) {
    $('#roomInfo').style.display = 'block';
    $('#roomCodeDisplay').textContent = code;
    $('.connection-section').style.display = 'none';
    $('#transferSection').style.display = 'block';
    history.replaceState(null, '', '#' + code);
  }

  function openFilePicker() {
    var input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', function() {
      if (input.files.length > 0) {
        addFilesToQueue(Array.prototype.slice.call(input.files));
      }
      document.body.removeChild(input);
    });
    input.click();
  }

  function openFolderPicker() {
    var input = document.createElement('input');
    input.type = 'file';
    input.setAttribute('webkitdirectory', '');
    input.multiple = true;
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', function() {
      if (input.files.length > 0) {
        addFilesToQueue(Array.prototype.slice.call(input.files));
      }
      document.body.removeChild(input);
    });
    input.click();
  }

  function setupUploadZone() {
    var zone = $('#uploadZone');
    var selectFilesBtn = $('#selectFilesBtn');
    var selectFolderBtn = $('#selectFolderBtn');

    selectFilesBtn.addEventListener('click', function(e) {
      e.preventDefault();
      e.stopPropagation();
      openFilePicker();
    });

    selectFolderBtn.addEventListener('click', function(e) {
      e.preventDefault();
      e.stopPropagation();
      openFolderPicker();
    });

    zone.addEventListener('click', function(e) {
      if (e.target.closest('.upload-btn-row')) return;
      e.preventDefault();
      openFilePicker();
    });

    zone.addEventListener('dragover', function(e) {
      e.preventDefault();
      e.stopPropagation();
      zone.classList.add('drag-over');
    });

    zone.addEventListener('dragleave', function(e) {
      e.preventDefault();
      zone.classList.remove('drag-over');
    });

    zone.addEventListener('drop', function(e) {
      e.preventDefault();
      e.stopPropagation();
      zone.classList.remove('drag-over');
      if (e.dataTransfer.files.length > 0) {
        addFilesToQueue(Array.prototype.slice.call(e.dataTransfer.files));
      }
    });

    document.addEventListener('dragover', function(e) { e.preventDefault(); });
    document.addEventListener('drop', function(e) {
      e.preventDefault();
      if (e.dataTransfer.files.length > 0) {
        addFilesToQueue(Array.prototype.slice.call(e.dataTransfer.files));
      }
    });

    document.addEventListener('paste', function(e) {
      var items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      var files = [];
      for (var i = 0; i < items.length; i++) {
        if (items[i].kind === 'file') files.push(items[i].getAsFile());
      }
      if (files.length > 0) addFilesToQueue(files);
    });
  }

  function cleanup() {
    if (dataChannel) { try { dataChannel.close(); } catch(e) {} }
    if (peerConnection) { try { peerConnection.close(); } catch(e) {} }
    if (currentRoom) {
      db.ref('rooms/' + currentRoom).remove().catch(function() {});
    }
    peerConnection = null;
    dataChannel = null;
    isConnected = false;
  }

  window.addEventListener('beforeunload', cleanup);

  function init() {
    initTheme();
    setupUploadZone();
    listenForActiveRooms();

    $('#themeBtn').addEventListener('click', toggleTheme);
    $('#createRoomBtn').addEventListener('click', createRoom);
    $('#joinRoomBtn').addEventListener('click', function() { joinRoom($('#roomCodeInput').value); });
    $('#roomCodeInput').addEventListener('keydown', function(e) {
      if (e.key === 'Enter') joinRoom($('#roomCodeInput').value);
    });

    $('#copyRoomCode').addEventListener('click', function() {
      var code = $('#roomCodeDisplay').textContent;
      if (code) navigator.clipboard.writeText(code).then(function() { showToast('Copied!', 'success'); });
    });

    $('#showQRBtn').addEventListener('click', function() { showQRModal(); });
    $('#copyLinkBtn').addEventListener('click', function() {
      var code = $('#roomCodeDisplay').textContent;
      if (code) navigator.clipboard.writeText(getShareUrl(code)).then(function() { showToast('Link copied!', 'success'); });
    });

    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') {
        var overlay = document.getElementById('qrModalOverlay');
        if (overlay) document.body.removeChild(overlay);
      }
    });

    checkUrlForRoom();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
