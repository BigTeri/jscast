"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _events = require("events");

var _fluentFfmpeg = require("fluent-ffmpeg");

var _fluentFfmpeg2 = _interopRequireDefault(_fluentFfmpeg);

var _stream = require("../stream");

var _stream2 = _interopRequireDefault(_stream);

var _storage = require("../storage");

var _storage2 = _interopRequireDefault(_storage);

var _playlist = require("../playlist");

var _playlist2 = _interopRequireDefault(_playlist);

var _metadata = require("./metadata");

var _metadata2 = _interopRequireDefault(_metadata);

var _destroy = require("destroy");

var _destroy2 = _interopRequireDefault(_destroy);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

class Station extends _events.EventEmitter {
  constructor(options) {
    super();

    options = options || {};
    this.playlists = options.playlists || [];
    this.bufferSize = options.bufferSize || null;
    this.dataInterval = options.dataInterval || null;
    this.prebufferSize = options.prebufferSize || null;
    this.postProcessingBitRate = options.postProcessingBitRate || 128;
    this.storageType = options.storageType || "JSON";
    this.ffmpegPath = options.ffmpegPath || null;

    this.ffmpegPath && _fluentFfmpeg2.default.setFfmpegPath(this.ffmpegPath);
    this.storage = new _storage2.default(this.storageType);

    this.itemId = null;
    this.item = null;
    this.metadata = null;

    this.stream = new _stream2.default({
      bufferSize: this.bufferSize,
      dataInterval: this.dataInterval,
      prebufferSize: this.prebufferSize,
      needMoreData: this.streamNeedsMoreData.bind(this)
    });
    this.stream.once("data", () => this.emit("start"));
    this.stream.on("data", (data, metadata, item) => {
      if (this.itemId !== item._id) {
        this.itemId = item._id;
        this.item = item;
        this.metadata = metadata;
        this.emit("play", item, metadata);
      }

      this.emit("data", data, metadata, item);
    });

    this.playlistPlay = this.playlistPlay.bind(this);
    this.playlistReplace = this.playlistReplace.bind(this);

    this.playlists = this.playlists.map(items => new _playlist2.default({
      items: items
    }));
  }

  start() {
    this.storage.activate({}, err => {
      if (err) return console.log(err);
      this.storage.fill(this.playlists, () => {
        this.storage.findAll((err, playlists) => {
          if (err) return console.log(err);
          this.playlists = playlists;

          this.stream.start();
        });
      });
    });
  }

  addPlaylist(playlist) {
    playlist = this.preparePlaylist(playlist);
    this.storage.insert(playlist, err => {
      if (err) return console.log(err);

      this.playlists.push(playlist);

      this.emit("playlistCreated", playlist);

      if (!this.playlist) {
        this.handleNoPlaylist();
      }
    });
  }

  addItem(item) {
    const playlist = this.playlist;
    if (playlist) {
      const wasPlaylistEmpty = playlist.items.length < 1;
      item = playlist.addItem(item);

      this.storage.update(playlist, err => {
        // TODO: remove item if err
        if (err) return console.log(err);

        this.emit("itemCreated", item, playlist);

        if (wasPlaylistEmpty) {
          this.playNext();
        }
      });
    } else {
      // TODO: create playlist with item in it
      console.log("NYI");
    }
  }

  removeItem(id, playlistId) {
    const playlist = this.findPlaylistById(playlistId);
    if (playlist) {
      const removed = playlist.removeItem(id);
      const itemIndex = playlist.items.indexOf(removed);
      if (removed) {
        this.storage.update(playlist, err => {
          if (err) {
            playlist.items.splice(itemIndex, 0, removed);
            return console.error(err);
          }

          this.emit("itemRemoved", removed, playlist);

          if (removed._id === this.itemId) {
            this.replaceNext();
          }
        });
      } else {
        console.log("item to remove not found");
      }
    } else {
      console.log("playlist not found");
    }
  }

  removePlaylist(playlistId) {
    const playlist = this.findPlaylistById(playlistId);
    if (playlist) {
      const playlistIndex = this.playlists.indexOf(playlist);
      this.playlists.splice(playlistIndex, 1);
      this.storage.remove(playlist._id, err => {
        if (err) {
          this.playlists.splice(playlistIndex, 0, playlist);
          return console.error(err);
        }

        this.emit("playlistRemoved", playlist);

        if (playlist._id === this.playlist._id) {
          this.playlist = null;
          this.replaceNext();
        }
      });
    } else {
      console.log("playlist to remove not found");
    }
  }

  preparePlaylist(playlist) {
    playlist = playlist || [];
    if (Array.isArray(playlist)) {
      return new _playlist2.default(playlist);
    } else {
      return playlist;
    }
  }

  replacePlaylistByPlaylistId(playlistId) {
    const playlist = this.findPlaylistById(playlistId);
    if (playlist) this.replacePlaylist(playlist);
  }

  replacePlaylistByPlaylistIdAndItemId(playlistId, itemId) {
    const playlist = this.findPlaylistById(playlistId);
    if (playlist) {
      this.replacePlaylistAndItemId(playlist, itemId);
    }
  }

  replacePlaylist(playlist) {
    this.changePlaylist(playlist);
    this.replaceNext();
  }

  replacePlaylistAndItemId(playlist, itemId) {
    this.changePlaylist(playlist);
    this.replaceItemId(itemId);
  }

  changePlaylist(playlist) {
    if (this.playlist && this.playlist._id === playlist._id) return;

    if (this.playlist) {
      this.playlist.removeListener("play", this.playlistPlay);
      this.playlist.removeListener("replace", this.playlistReplace);
    }
    this.playlist = playlist;
    this.playlist.on("play", this.playlistPlay);
    this.playlist.on("replace", this.playlistReplace);
  }

  findPlaylistById(id) {
    return this.playlists.find(playlist => {
      return playlist._id === id;
    });
  }

  playNext() {
    if (this.playlist) {
      this.handleNothingToPlay(!this.playlist.playNext());
    } else {
      this.handleNoPlaylist();
    }
  }

  replaceNext() {
    if (this.playlist) {
      this.handleNothingToPlay(!this.playlist.replaceNext());
    } else {
      this.handleNoPlaylist();
    }
  }

  replaceItemId(itemId) {
    if (this.playlist) {
      const canPlay = !this.playlist.replaceItemByItemId(itemId);
      if (!canPlay) {
        this.replaceNext();
      }
    } else {
      this.handleNoPlaylist();
    }
  }

  handleNothingToPlay(isPlaylistEmpty) {
    if (isPlaylistEmpty) {
      this.emit("nothingToPlay", this.playlist);
    }
  }

  handleNoPlaylist() {
    if (this.playlists.length > 0) {
      this.replacePlaylist(this.playlists[0]);
    } else {
      this.emit("nothingToPlay", this.playlist);
    }
  }

  streamNeedsMoreData() {
    this.playNext();
  }

  playlistPlay(err, stream, metadata, item, options) {
    if (err) return this.onPlayError(err);
    options = options || {};

    this.handleStreamError(stream);

    stream = this.handlePostProcessing(stream, options);
    metadata = new _metadata2.default(metadata);
    this.stream.next(stream, metadata, item);
  }

  playlistReplace(err, stream, metadata, item, options) {
    if (err) return this.onPlayError(err);
    options = options || {};

    this.handleStreamError(stream);

    stream = this.handlePostProcessing(stream, options);
    metadata = new _metadata2.default(metadata);
    this.stream.replace(stream, metadata, item);
  }

  onPlayError(err) {
    this.emit("error", err);
    console.log("trying to play next item...");
    this.playNext();
  }

  handleStreamError(stream) {
    return stream.once("error", err => {
      (0, _destroy2.default)(stream);
      this.onPlayError(err);
    });
  }

  handlePostProcessing(stream, options) {
    options = options || {};

    if (options.streamNeedsPostProcessing) {
      stream = (0, _fluentFfmpeg2.default)(stream).audioBitrate(this.postProcessingBitRate).format("mp3");
    }

    return this.handleStreamError(stream);
  }
}
exports.default = Station;