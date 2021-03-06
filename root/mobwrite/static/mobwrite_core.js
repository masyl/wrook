/**
 * MobWrite - Real-time Synchronization and Collaboration Service
 *
 * Copyright 2006 Neil Fraser
 * http://code.google.com/p/google-mobwrite/
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * @fileoverview This client-side code drives the synchronisation.
 * @author fraser@google.com (Neil Fraser)
 */


/**
 * Singleton class containing all MobWrite code.
 */
var mobwrite = {};


/**
 * URL of Ajax gateway.
 * @type {string}
 */
mobwrite.syncGateway = '/scripts/q.py';


/**
 * Max size of remote JSON-P gets.
 * @type {number}
 */
mobwrite.get_maxchars = 200;


/**
 * Browser sniff. Required to work around bugs in common implementations.
 * Sets mobwrite's UA_* properties.
 */
mobwrite.sniffUserAgent = function() {
  if (window.opera) {
    mobwrite.UA_opera = true;
  } else {
    var UA = navigator.userAgent.toLowerCase();
    mobwrite.UA_webkit = UA.indexOf('webkit') != -1;
    // Safari claims to be 'like Gecko'
    if (!mobwrite.UA_webkit) {
      mobwrite.UA_gecko = UA.indexOf('gecko') != -1;
      if (!mobwrite.UA_gecko) {
        // Test last, everyone wants to be like IE.
        mobwrite.UA_msie = UA.indexOf('msie') != -1;
      }
    }
  }
};

mobwrite.UA_gecko = false;
mobwrite.UA_opera = false;
mobwrite.UA_msie = false;
mobwrite.UA_webkit = false;
mobwrite.sniffUserAgent();


/**
 * PID of task which will trigger next Ajax request.
 * @type {number?}
 * @private
 */
mobwrite.syncRunPid_ = null;


/**
 * PID of task which will kill stalled Ajax request.
 * @type {number?}
 * @private
 */
mobwrite.syncKillPid_ = null;


/**
 * Time to wait for a connection before giving up and retrying.
 * @type {number}
 */
mobwrite.timeoutInterval = 30000;


/**
 * Shortest interval (in milliseconds) between connections.
 * @type {number}
 */
mobwrite.minSyncInterval = 1000;


/**
 * Longest interval (in milliseconds) between connections.
 * @type {number}
 */
mobwrite.maxSyncInterval = 10000;


/**
 * Initial interval (in milliseconds) for connections.
 * This value is modified later as traffic rates are established.
 * @type {number}
 */
mobwrite.syncInterval = 2000;


/**
 * Track whether something changed client-side or server-side in each sync.
 * @type {boolean}
 * @private
 */
mobwrite.syncChange_ = false;


/**
 * Temporary object used while each sync is airborne.
 * @type {Object?}
 * @private
 */
mobwrite.syncAjaxObj_ = null;


/**
 * Return a random id that's 8 letters long.
 * 26*(26+10+4)^7 = 4,259,840,000,000
 * @return {String} Random id.
 */
mobwrite.uniqueId = function() {
  // First character must be a letter.
  // IE is case insensitive (in violation of the W3 spec).
  var soup = 'abcdefghijklmnopqrstuvwxyz';
  var id = soup.charAt(Math.random() * soup.length);
  // Subsequent characters may include these.
  soup += '0123456789-_:.';
  for (var x = 1; x < 8; x++) {
    id += soup.charAt(Math.random() * soup.length);
  }
  // Don't allow IDs with '--' in them since it might close a comment.
  if (id.indexOf('--') != -1) {
    id = mobwrite.uniqueId();
  }
  return id;
  // Getting the maximum possible density in the ID is worth the extra code,
  // since the ID is transmitted back and forth a lot.
};


/**
 * Unique ID for this session.
 * @type {string}
 */
mobwrite.syncUsername = mobwrite.uniqueId();


/**
 * Hash of all shared objects.
 * @type {Object}
 */
mobwrite.shared = {};


/**
 * Array of registered handlers for sharing types.
 * Modules add their share functions to this list.
 * @type {Array<Function>}
 */
mobwrite.shareHandlers = [];


/**
 * Prototype of shared object.
 * @param {string} id Unique file ID
 * @constructor
 */
mobwrite.shareObj = function(id) {
  if (id) {
    this.file = id;
    this.dmp = new diff_match_patch();
  }
};


/**
 * Client's understanding of what the server's text looks like.
 * @type {string}
 */
mobwrite.shareObj.prototype.serverText = '';


/**
 * Did the client understand the server's delta in the previous heartbeat?
 * Initialize false because the server and client are out of sync initially.
 * @type {boolean}
 */
mobwrite.shareObj.prototype.deltaOk = false;


/**
 * Synchronization mode.
 * True: Used for text, attempts to gently merge differences together.
 * False: Used for numbers, overwrites conflicts, last save wins.
 * @type {boolean}
 */
mobwrite.shareObj.prototype.mergeChanges = true;


/**
 * Fetch or compute a plaintext representation of the user's text
 * @return {string} Plaintext content.
 */
mobwrite.shareObj.prototype.getClientText = function() {
  window.alert('Defined by subclass');
  return '';
};


/**
 * Set the user's text based on the provided plaintext.
 * @param {string} text New text
 */
mobwrite.shareObj.prototype.setClientText = function(text) {
  window.alert('Defined by subclass');
};


/**
 * Modify the user's plaintext by applying a series of patches against it.
 * @param {Array<patch_obj>} patches Array of Patch objects
 */
mobwrite.shareObj.prototype.patchClientText = function(patches) {
  var oldClientText = this.getClientText();
  result = this.dmp.patch_apply(patches, oldClientText);
  // Set the new text only if there is a change to be made.
  if (oldClientText != result[0]) {
    // The following will probably destroy any cursor or selection.
    // Widgets with cursors should override and patch more delicately.
    this.setClientText(result[0]);
  }
};


/**
 * Notification of when a diff was sent to the server.
 * @param {Array.<Array.<*>>} diffs Array of diff tuples
 */
mobwrite.shareObj.prototype.onSentDiff = function(diffs) {
  // Potential hook for subclass.
};


/**
 * Fire a synthetic 'change' event to a target element.
 * Notifies an element that its contents have been changed.
 * @param {Object} target Element to notify
 */
mobwrite.shareObj.prototype.fireChange = function(target) {
  if ('createEvent' in document) {
    var e = document.createEvent('HTMLEvents');
    e.initEvent('change', false, false);
    target.dispatchEvent(e);
  } else if ('fireEvent' in target) {
    target.fireEvent('onchange');
  }
};


/**
 * Asks the shareObj to synchronize.  Computes client-made changes since
 * previous postback.  Return '' to skip this synchronization.
 * @return {string} Commands to be sent to the server.
 */
mobwrite.shareObj.prototype.syncText = function() {
  var data;
  var clientText = this.getClientText();
  if (this.deltaOk) {
    // The last delta postback from the server to this shareObj was successful.
    // Send a compressed delta.
    var diffs = this.dmp.diff_main(this.serverText, clientText, true);
    if (diffs.length > 2) {
      this.dmp.diff_cleanupSemantic(diffs);
      this.dmp.diff_cleanupEfficiency(diffs);
    }
    this.onSentDiff(diffs);
    this.serverText = clientText;
    data = (this.mergeChanges ? 'd:' : 'D:') + this.dmp.diff_toDelta(diffs);
    if (diffs.length != 1 || diffs[0][0] != DIFF_EQUAL) {
      mobwrite.syncChange_ = true;
    }
  } else {
    // The last delta postback from the server to this shareObj didn't match.
    // Send a full text dump to get back in sync. This will result in any
    // changes since the last postback being wiped out. :(
    data = clientText;
    if (this.serverText != clientText) {
      this.serverText = clientText;
    }
    data = encodeURI(data).replace(/%20/g, ' ');
    data = 'r:' + data;
  }

  data = 'F:' + encodeURI(this.file) + '\n' + data + '\n';
  // Opera doesn't know how to encode char 0.
  return data.replace(/\0/g, '%00');
};


/**
 * Collect all client-side changes and send them to the server.
 * @private
 */
mobwrite.syncRun1_ = function() {
  // Initialize syncChange_, to be checked at the end of syncRun2_.
  mobwrite.syncChange_ = false;
  var empty = true;
  var data = 'u:' + mobwrite.syncUsername + '\n';
  // Ask every shared object for their deltas.
  for (x in mobwrite.shared) {
    data += mobwrite.shared[x].syncText();
    empty = false;
  }
  if (empty) {
    // No sync objects.
    return;
  }
  var remote = (mobwrite.syncGateway.indexOf('http://') == 0);
  //window.alert('TO server:\n[' + data + ']');
  // Add terminating blank line.
  data += '\n';

  // Schedule a watchdog task to catch us if something horrible happens.
  mobwrite.syncKillPid_ = window.setTimeout(mobwrite.syncKill_, mobwrite.timeoutInterval);
  if (remote) {
    // Remove any old script tags.
    var script;
    while (script = document.getElementById('mobwrite_sync')) {
      script.parentNode.removeChild(script);
    }
    var blocks = [];
    if (data.length > mobwrite.get_maxchars) {
      // Break the data into small blocks.
      // Compute number of blocks.
      var bufferBlocks = Math.ceil(data.length / mobwrite.get_maxchars);
      // Compute length of each block.
      var blockLength = Math.ceil(data.length / bufferBlocks);
      // Obtain a random ID for this buffer.
      var bufferHeader = 'b:' + mobwrite.uniqueId() + ' ' + bufferBlocks + ' ';
      for (var x = 1; x <= bufferBlocks; x++) {
        var bufferData = encodeURIComponent(data.substring((x - 1) * blockLength, x * blockLength));
        var block = bufferHeader + x + ' ' + bufferData + '\n\n';
        blocks.push('p=' + encodeURIComponent(block));
      }
    } else {
      // Encode to a URL.
      blocks = ['p=' + encodeURIComponent(data)];
    }
    // Add a script tag to the head.
    var head = document.getElementsByTagName('head')[0];
    for (var x = 0; x < blocks.length; x++) {
      script = document.createElement('script');
      script.type = 'text/javascript';
      script.charset = 'utf-8';
      // Add a uniqueId for cache-busting purposes.
      script.src =
          mobwrite.syncGateway + '?' + blocks[x] + '&c=' + mobwrite.uniqueId();
      script.id = 'mobwrite_sync';
      head.appendChild(script);
    }
    // Execution will resume in mobwrite.callback();
  } else {
    // Issue Ajax post of client-side changes and request server-side changes.
    data = 'q=' + encodeURIComponent(data);
    mobwrite.syncAjaxObj_ = mobwrite.syncLoadAjax_(mobwrite.syncGateway, data,
        mobwrite.syncCheckAjax_);
    // Execution will resume in either syncCheckAjax_(), or syncKill_()
  }
};


/**
 * Callback location for JSON-P requests.
 */
mobwrite.callback = function(text) {
  // Only process the response if there is a response.
  // Don't schedule a new heartbeat due to one of the many null responses from
  // a buffer push.
  if (text) {
    mobwrite.syncRun2_(text);
  }
};


/**
 * Parse all server-side changes and distribute them to the shared objects.
 * @private
 */
mobwrite.syncRun2_ = function(text) {
  //window.alert('FROM server:\n[' + text + ']');
  // Opera doesn't know how to decode char 0.
  text = text.replace(/%00/g, '\0');
  var lines = text.split('\n');
  var file = null;
  for (var x in lines) {
    // Divide each line into 'N:value' pairs.
    if (lines[x].charAt(1) != ':') {
      continue;
    }
    var name = lines[x].charAt(0);
    var value = lines[x].substring(2);
    if (name == 'F' || name == 'f') {
      // FILE indicates which shared object following delta/raw applies to.
      if (mobwrite.shared.hasOwnProperty(value)) {
        file = mobwrite.shared[value];
        file.deltaOk = true;
      } else {  // WTF?
        file = null;
      }
    } else if (name == 'R' || name == 'r') {
      // The server reports it was unable to integrate the previous delta.
      if (file) {
        file.serverText = decodeURI(value);
        if (name == 'R') {
          // Accept the server's raw text dump and wipe out any user's changes.
          file.setClientText(file.serverText);
        }
        // Server-side activity.
        mobwrite.syncChange_ = true;
      }
    } else if (name == 'D' || name == 'd') {
      // The server offers a compressed delta of changes to be applied.
      if (file) {
        var diffs;
        try {
          diffs = file.dmp.diff_fromDelta(file.serverText, value);
        } catch (ex) {
          // The delta the server supplied does not fit on our copy of
          // serverText.
          diffs = null;
          // Set deltaOk to false so that on the next sync we send
          // a complete dump to get back in sync.
          file.deltaOk = false;
          // Do the next sync soon because the user will lose any changes.
          mobwrite.syncInterval = 0;
          window.alert('Delta mismatch.\n' + encodeURI(file.serverText));
        }
        if (diffs && (diffs.length != 1 || diffs[0][0] != DIFF_EQUAL)) {
          // Compute and apply the patches.
          if (name == 'D') {
            // Overwrite text.
            file.serverText = file.dmp.diff_text2(diffs);
            file.setClientText(file.serverText);
          } else {
            // Merge text.
            var patches = file.dmp.patch_make(file.serverText, '', diffs);
            // First serverText.  Should be guaranteed to work.
            var serverResult = file.dmp.patch_apply(patches, file.serverText);
            file.serverText = serverResult[0];
            // Second the user's text.
            file.patchClientText(patches);
          }
          // Server-side activity.
          mobwrite.syncChange_ = true;
        }
      }
    }
  }

  if (mobwrite.syncChange_) {
    // Activity (client-side or server-side).  Cut the ping interval.
    mobwrite.syncInterval /= 2;
  } else {
    // Let the ping interval creep up.
    mobwrite.syncInterval += 1000;
  }
  // Keep the syncs constrained between 1 and 10 seconds.
  mobwrite.syncInterval =
      Math.max(mobwrite.minSyncInterval, mobwrite.syncInterval);
  mobwrite.syncInterval =
      Math.min(mobwrite.maxSyncInterval, mobwrite.syncInterval);
  // Ensure that there is only one sync task.
  window.clearTimeout(mobwrite.syncRunPid_);
  // Schedule the next sync.
  mobwrite.syncRunPid_ =
      window.setTimeout(mobwrite.syncRun1_, mobwrite.syncInterval);
  // Terminate the watchdog task, everything's ok.
  window.clearTimeout(mobwrite.syncKillPid_);
  mobwrite.syncKillPid_ = null;
};


/**
 * If the Ajax call doesn't complete after a timeout period, start over.
 * @private
 */
mobwrite.syncKill_ = function() {
  mobwrite.syncKillPid_ = null;
  if (mobwrite.syncAjaxObj_) {
    // Cleanup old Ajax connection.
    mobwrite.syncAjaxObj_.abort();
    mobwrite.syncAjaxObj_ = null;
  }
  window.alert('Warning: Connection failure.');
  window.clearTimeout(mobwrite.syncRunPid_);
  // Initiate a new sync right now.
  mobwrite.syncRunPid_ = window.setTimeout(mobwrite.syncRun1_, 1);
};


/**
 * Initiate an Ajax network connection.
 * @param {string} url Location to send request
 * @param {string} post Data to be sent
 * @param {Function} callback Function to be called when response arrives
 * @return {Object?} New Ajax object or null if failure.
 * @private
 */
mobwrite.syncLoadAjax_ = function(url, post, callback) {
  var req = null;
  // branch for native XMLHttpRequest object
  if (window.XMLHttpRequest) {
    try {
      req = new XMLHttpRequest();
    } catch(e) {
      req = null;
    }
    // branch for IE/Windows ActiveX version
    } else if (window.ActiveXObject) {
    try {
      req = new ActiveXObject('Msxml2.XMLHTTP');
    } catch(e) {
      try {
        req = new ActiveXObject('Microsoft.XMLHTTP');
      } catch(e) {
      	req = null;
      }
    }
  }
  if (req) {
    req.onreadystatechange = callback;
    req.open('POST', url, true);
    req.setRequestHeader('Content-Type','application/x-www-form-urlencoded');
    req.send(post);
  }
  return req;
};


/**
 * Callback function for Ajax request.  Checks network response was ok,
 * then calls mobwrite.syncRun2_
 * @private
 */
mobwrite.syncCheckAjax_ = function() {
  if (typeof mobwrite == 'undefined' || !mobwrite.syncAjaxObj_) {
    // This might be a callback after the page has unloaded,
    // or this might be a callback which we deemed to have timed out.
    return;
  }
  // Only if req shows "loaded"
  if (mobwrite.syncAjaxObj_.readyState == 4) {
    // Only if "OK"
    if (mobwrite.syncAjaxObj_.status == 200) {
      var text = mobwrite.syncAjaxObj_.responseText;
      mobwrite.syncAjaxObj_ = null;
      mobwrite.syncRun2_(text);
    } else {
      window.alert('Connection error code: ' + mobwrite.syncAjaxObj_.status);
      mobwrite.syncAjaxObj_ = null;
    }
  }
};


/**
 * When unloading, run a sync one last time.
 * @private
 */
mobwrite.unload_ = function() {
  if (!mobwrite.syncKillPid_) {
    mobwrite.syncRun1_();
  }
  // By the time the callback runs mobwrite.syncRun2_, this page will probably
  // be gone.  But that's ok, we are just sending our last changes out, we
  // don't care what the server says.
};


// Attach unload event to window.
if (window.addEventListener) {  // W3
  window.addEventListener('unload', mobwrite.unload_, false);
} else if (window.attachEvent) {  // IE
  window.attachEvent('onunload', mobwrite.unload_);
}


/**
 * Start sharing the specified object(s).
 * @param {*} var_args Object(s) or ID(s) of object(s) to share
 */
mobwrite.share = function(var_args) {
  for (var i = 0; i < arguments.length; i++) {
    var el = arguments[i];
    var result = null;
    // Ask every registered handler if it knows what to do with this object.
    for (var x = 0; x < mobwrite.shareHandlers.length && !result; x++) {
      result = mobwrite.shareHandlers[x].call(mobwrite, el);
    }
    if (result && result.file) {
      mobwrite.shared[result.file] = result;

      // Startup the main task if it doesn't aleady exist.
      if (mobwrite.syncRunPid_ == null) {
        mobwrite.syncRunPid_ = window.setTimeout(mobwrite.syncRun1_, 10);
      }
    }
  }
};
