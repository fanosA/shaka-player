/**
 * @license
 * Copyright 2016 Google Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

goog.provide('shaka.polyfill.MediaSource');

goog.require('shaka.log');
goog.require('shaka.polyfill.register');


/**
 * @namespace shaka.polyfill.MediaSource
 *
 * @summary A polyfill to patch MSE bugs.
 */


/**
 * Install the polyfill if needed.
 */
shaka.polyfill.MediaSource.install = function() {
  shaka.log.debug('MediaSource.install');

  // MediaSource bugs are difficult to detect without checking for the affected
  // platform.  SourceBuffer is not always exposed on window, for example, and
  // instances are only accessible after setting up MediaSource on a video
  // element.  Because of this, we use UA detection and other platform detection
  // tricks to decide which patches to install.

  if (!window.MediaSource) {
    shaka.log.info('No MSE implementation available.');
  } else if (window.cast && cast.__platform__ &&
             cast.__platform__.canDisplayType) {
    shaka.log.info('Patching Chromecast MSE bugs.');
    // Chromecast cannot make accurate determinations via isTypeSupported.
    shaka.polyfill.MediaSource.patchCastIsTypeSupported_();
  } else if (navigator.vendor && navigator.vendor.indexOf('Apple') >= 0) {
    var version = navigator.appVersion;

    // TS content is broken in Safari in general.
    // See https://github.com/google/shaka-player/issues/743
    // and https://bugs.webkit.org/show_bug.cgi?id=165342
    shaka.polyfill.MediaSource.rejectTsContent_();

    if (version.indexOf('Version/8') >= 0) {
      // Safari 8 does not implement appendWindowEnd.  If we ignore the
      // incomplete MSE implementation, some content (especially multi-period)
      // will fail to play correctly.  The best we can do is blacklist Safari 8.
      shaka.log.info('Blacklisting Safari 8 MSE.');
      shaka.polyfill.MediaSource.blacklist_();
    } else if (version.indexOf('Version/9') >= 0) {
      shaka.log.info('Patching Safari 9 MSE bugs.');
      // Safari 9 does not correctly implement abort() on SourceBuffer.
      // Calling abort() causes a decoder failure, rather than resetting the
      // decode timestamp as called for by the spec.
      // Bug filed: http://goo.gl/UZ2rPp
      shaka.polyfill.MediaSource.stubAbort_();
    } else if (version.indexOf('Version/10') >= 0) {
      shaka.log.info('Patching Safari 10 MSE bugs.');
      // Safari 10 does not correctly implement abort() on SourceBuffer.
      // Calling abort() before appending a segment causes that segment to be
      // incomplete in buffer.
      // Bug filed: https://goo.gl/rC3CLj
      shaka.polyfill.MediaSource.stubAbort_();
      // Safari 10 fires spurious 'updateend' events after endOfStream().
      // Bug filed: https://goo.gl/qCeTZr
      shaka.polyfill.MediaSource.patchEndOfStreamEvents_();
    } else if (version.indexOf('Version/11') >= 0) {
      shaka.log.info('Patching Safari 11 MSE bugs.');
      // Safari 11 does not correctly implement abort() on SourceBuffer.
      // Calling abort() before appending a segment causes that segment to be
      // incomplete in buffer.
      // Bug filed: https://goo.gl/rC3CLj
      shaka.polyfill.MediaSource.stubAbort_();
      // If you remove up to a keyframe, Safari 11 incorrectly will also remove
      // that keyframe and the content up to the next.
      // Offsetting the end of the removal range seems to help.
      // Bug filed: https://goo.gl/h2yDPN
      shaka.polyfill.MediaSource.patchRemovalRange_();
    }
  } else {
    shaka.log.info('Using native MSE as-is.');
  }
};


/**
 * Blacklist the current browser by making MediaSourceEngine.isBrowserSupported
 * fail later.
 *
 * @private
 */
shaka.polyfill.MediaSource.blacklist_ = function() {
  window['MediaSource'] = null;
};


/**
 * Stub out abort().  On some buggy MSE implementations, calling abort() causes
 * various problems.
 *
 * @private
 */
shaka.polyfill.MediaSource.stubAbort_ = function() {
  var addSourceBuffer = MediaSource.prototype.addSourceBuffer;
  MediaSource.prototype.addSourceBuffer = function() {
    var sourceBuffer = addSourceBuffer.apply(this, arguments);
    sourceBuffer.abort = function() {};  // Stub out for buggy implementations.
    return sourceBuffer;
  };
};


/**
 * Patch remove().  On Safari 11, if you call remove() to remove the content up
 * to a keyframe, Safari will also remove the keyframe and all of the data up to
 * the next one. For example, if the keyframes are at 0s, 5s, and 10s, and you
 * tried to remove 0s-5s, it would instead remove 0s-10s.
 *
 * Offsetting the end of the range seems to be a usable workaround.
 *
 * @private
 */
shaka.polyfill.MediaSource.patchRemovalRange_ = function() {
  var originalRemove = SourceBuffer.prototype.remove;

  SourceBuffer.prototype.remove = function(startTime, endTime) {
    return originalRemove.call(this, startTime, endTime - 0.001);
  };
};


/**
 * Patch endOfStream() to get rid of 'updateend' events that should not fire.
 * These extra events confuse MediaSourceEngine, which relies on correct events
 * to manage SourceBuffer state.
 *
 * @private
 */
shaka.polyfill.MediaSource.patchEndOfStreamEvents_ = function() {
  var endOfStream = MediaSource.prototype.endOfStream;
  MediaSource.prototype.endOfStream = function() {
    // This bug manifests only when endOfStream() results in the truncation
    // of the MediaSource's duration.  So first we must calculate what the
    // new duration will be.
    var newDuration = 0;
    for (var i = 0; i < this.sourceBuffers.length; ++i) {
      var buffer = this.sourceBuffers[i];
      var bufferEnd = buffer.buffered.end(buffer.buffered.length - 1);
      newDuration = Math.max(newDuration, bufferEnd);
    }

    // If the duration is going to be reduced, suppress the next 'updateend'
    // event on each SourceBuffer.
    if (!isNaN(this.duration) &&
        newDuration < this.duration) {
      this.ignoreUpdateEnd_ = true;
      for (var i = 0; i < this.sourceBuffers.length; ++i) {
        var buffer = this.sourceBuffers[i];
        buffer.eventSuppressed_ = false;
      }
    }

    return endOfStream.apply(this, arguments);
  };

  var cleanUpHandlerInstalled = false;
  var addSourceBuffer = MediaSource.prototype.addSourceBuffer;
  MediaSource.prototype.addSourceBuffer = function() {
    // After adding a new source buffer, add an event listener to allow us to
    // suppress events.
    var sourceBuffer = addSourceBuffer.apply(this, arguments);
    sourceBuffer['mediaSource_'] = this;
    sourceBuffer.addEventListener('updateend',
        shaka.polyfill.MediaSource.ignoreUpdateEnd_, false);

    if (!cleanUpHandlerInstalled) {
      // If we haven't already, install an event listener to allow us to clean
      // up listeners when MediaSource is torn down.
      this.addEventListener('sourceclose',
          shaka.polyfill.MediaSource.cleanUpListeners_, false);
      cleanUpHandlerInstalled = true;
    }
    return sourceBuffer;
  };
};


/**
 * An event listener for 'updateend' which selectively suppresses the events.
 *
 * @see shaka.polyfill.MediaSource.patchEndOfStreamEvents_
 *
 * @param {Event} event
 * @private
 */
shaka.polyfill.MediaSource.ignoreUpdateEnd_ = function(event) {
  var sourceBuffer = event.target;
  var mediaSource = sourceBuffer['mediaSource_'];

  if (mediaSource.ignoreUpdateEnd_) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    sourceBuffer.eventSuppressed_ = true;

    for (var i = 0; i < mediaSource.sourceBuffers.length; ++i) {
      var buffer = mediaSource.sourceBuffers[i];
      if (buffer.eventSuppressed_ == false) {
        // More events need to be suppressed.
        return;
      }
    }

    // All events have been suppressed, all buffers are out of 'updating'
    // mode.  Stop suppressing events.
    mediaSource.ignoreUpdateEnd_ = false;
  }
};


/**
 * An event listener for 'sourceclose' which cleans up listeners for 'updateend'
 * to avoid memory leaks.
 *
 * @see shaka.polyfill.MediaSource.patchEndOfStreamEvents_
 * @see shaka.polyfill.MediaSource.ignoreUpdateEnd_
 *
 * @param {Event} event
 * @private
 */
shaka.polyfill.MediaSource.cleanUpListeners_ = function(event) {
  var mediaSource = /** @type {!MediaSource} */ (event.target);
  for (var i = 0; i < mediaSource.sourceBuffers.length; ++i) {
    var buffer = mediaSource.sourceBuffers[i];
    buffer.removeEventListener('updateend',
        shaka.polyfill.MediaSource.ignoreUpdateEnd_, false);
  }
  mediaSource.removeEventListener('sourceclose',
      shaka.polyfill.MediaSource.cleanUpListeners_, false);
};


/**
 * Patch isTypeSupported() to reject TS content.  Used to avoid TS-related MSE
 * bugs on Safari.
 *
 * @private
 */
shaka.polyfill.MediaSource.rejectTsContent_ = function() {
  var originalIsTypeSupported = MediaSource.isTypeSupported;

  MediaSource.isTypeSupported = function(mimeType) {
    // Parse the basic MIME type from its parameters.
    var pieces = mimeType.split(/ *; */);
    var basicMimeType = pieces[0];
    var container = basicMimeType.split('/')[1];

    if (container == 'mp2t') {
      return false;
    }

    return originalIsTypeSupported(mimeType);
  };
};


/**
 * Patch isTypeSupported() to parse for HDR-related clues and chain to a private
 * API on the Chromecast which can query for support.
 *
 * @private
 */
shaka.polyfill.MediaSource.patchCastIsTypeSupported_ = function() {
  var originalIsTypeSupported = MediaSource.isTypeSupported;

  // Docs from Dolby detailing profile names: https://goo.gl/LVVXrS
  var dolbyVisionRegex = /^dv(?:he|av)\./;

  MediaSource.isTypeSupported = function(mimeType) {
    // Parse the basic MIME type from its parameters.
    var pieces = mimeType.split(/ *; */);
    var basicMimeType = pieces[0];

    // Parse the parameters into key-value pairs.
    /** @type {Object.<string, string>} */
    var parameters = {};
    for (var i = 1; i < pieces.length; ++i) {
      var kv = pieces[i].split('=');
      var k = kv[0];
      var v = kv[1].replace(/"(.*)"/, '$1');
      parameters[k] = v;
    }

    var codecs = parameters['codecs'];
    if (!codecs) {
      return originalIsTypeSupported(mimeType);
    }

    var isHDR = false;
    var isDolbyVision = false;

    var codecList = codecs.split(',').filter(function(codec) {
      // Remove Dolby Vision codec strings.  These are not understood on
      // Chromecast, even though the content can still be played.
      if (dolbyVisionRegex.test(codec)) {
        isDolbyVision = true;
        // Return false to remove this string from the list.
        return false;
      }

      // We take this string as a signal for HDR, but don't remove it.
      if (/^(hev|hvc)1\.2/.test(codec)) {
        isHDR = true;
      }

      // Keep all other strings in the list.
      return true;
    });

    // If the content uses Dolby Vision, we take this as a sign that the content
    // is not HDR after all.
    if (isDolbyVision) isHDR = false;

    // Reconstruct the "codecs" parameter from the results of the filter.
    parameters['codecs'] = codecList.join(',');

    // If the content is HDR, we add this additional parameter so that the Cast
    // platform will check for HDR support.
    if (isHDR) {
      parameters['eotf'] = 'smpte2084';
    }

    // Reconstruct the MIME type, possibly with additional parameters.
    var extendedMimeType = basicMimeType;
    for (var k in parameters) {
      var v = parameters[k];
      extendedMimeType += '; ' + k + '="' + v + '"';
    }
    return cast.__platform__.canDisplayType(extendedMimeType);
  };
};


shaka.polyfill.register(shaka.polyfill.MediaSource.install);
