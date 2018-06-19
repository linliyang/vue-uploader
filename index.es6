/**
 * 上传模块
 * @author linliyang
 */

import 'blueimp-canvas-to-blob'

const UPLOAD_STATUS = {
  WAITING: -1,
  UPLOADING: 0,
  SUCCESS: 1,
  FAIL: 2
}
const ERROR_CODE = {
  OVER_LIMIT_SIZE: 1,
  INVALID_EXTENSION: 2,
  NO_SERVER: 3,
  INVALID_SERVER_RESPONSE: 4,
  NO_SELECT_FILE: 5
}

function getFileExt (file) {
  let matched = file.name.match(/\.([^.\s]+)$/)
  return matched ? matched[1].toLowerCase() : 0
}

function isJpgImage (file) {
  let ext = getFileExt(file)
  return ['jpg', 'jpeg'].some((v) => {
    return v === ext
  })
}

function deepCopy (target, source) {
  function map (target, source) {
    for (let k in source) {
      if (!source.hasOwnProperty(k)) {
        continue
      }
      switch (Object.prototype.toString.call(target[k])) {
        case '[object Array]':
        case '[object Object]':
          map(target[k], source[k])
          break
        default:
          target[k] = source[k]
      }
    }
  }

  map(target, source)
}

export default class Uploader {
  constructor (config) {
    this._totalLoaded = 0 // 已上传的字节数
    this._activeThreads = 0  // 激活的线程
    this._chunks = []
    this._timestamp = null
    this._file = null

    this.server = ''
    this.method = 'post'
    this.chunkSize = 5 * 1024 * 1024
    this.fileSizeLimit = null
    this.maxThreads = 3  // 最大并发数
    this.arrayBufferMd5Computer = null
    this.headers = []
    this.extraFormData = []
    this.extensions = []
    this.onProgress = null
    this.onError = null
    this.onDone = null
    this.imageAutoCompress = false // 图片自动压缩,only for jpg
    this.compress = {
      width: 2000,
      height: 2000,
      quality: 0.92
    }
    this.builtInFormDataNames = {
      data: 'data',
      index: 'index',
      length: 'length',
      md5: 'md5',
      fileSize: 'fileSize',
      fileName: 'fileName',
      fileMd5: 'fileMd5'
    }
    deepCopy(this, config)
  }

  createChunks () {
    return new Promise((resolve, reject) => {
      let index = 0
      let start = 0
      if (this._file.size <= this.chunkSize) {
        this._chunks.push({
          blob: this._file,
          index: index++,
          md5: '',
          status: UPLOAD_STATUS.WAITING,
          timestamp: this._timestamp,
          canTriggerProgress: false
        })
        return resolve()
      }
      while (start < this._file.size) {
        this._chunks.push({
          blob: this._file.slice(start, start + this.chunkSize, this._file.type),
          index: index++,
          md5: '',
          status: UPLOAD_STATUS.WAITING,
          timestamp: this._timestamp,
          canTriggerProgress: false
        })
        start = start + this.chunkSize
      }
      resolve()
    })
  }

  addChunksMd5Info () {
    if (!this.arrayBufferMd5Computer) {
      return Promise.resolve()
    }
    let promises = []
    this._chunks.forEach((v, i) => {
      promises.push(this.addSingleChunkMd5Info(v))
    })
    return new Promise((resolve, reject) => {
      Promise.all(promises).then(() => {
        let fileReader = new FileReader()
        fileReader.addEventListener('load', (e) => {
          this._file.md5 = this.arrayBufferMd5Computer(e.target.result) // add file md5
          resolve(e.target.result)
        })
        fileReader.addEventListener('error', (e) => {
          reject(e)
          this.triggerError(e)
        })
        fileReader.readAsArrayBuffer(this._file)
      }).catch((e) => {
        reject(e)
        this.triggerError(e)
      })
    })
  }

  addSingleChunkMd5Info (chunk) {
    if (!this.arrayBufferMd5Computer) {
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      let fileReader = new FileReader()
      fileReader.addEventListener('load', (e) => {
        chunk.md5 = this.arrayBufferMd5Computer(e.target.result) // add chunk md5
        resolve(e.target.result)
      })
      fileReader.addEventListener('error', (e) => {
        reject(e)
        this.triggerError(e)
      })
      fileReader.readAsArrayBuffer(chunk.blob)
    })
  }

  uploadChunks () {
    let canUploadChunks = this.getCanUploadChunks()
    if (!canUploadChunks || !canUploadChunks.length) {
      return
    }
    canUploadChunks.forEach((chunk) => {
      this.uploadChunk(chunk)
    })
  }

  getCanUploadChunks () {
    let freeThreads = this.maxThreads - this._activeThreads
    if (freeThreads < 1) {
      return null
    }
    let waitingUploadChunks = this._chunks.filter(function (v) {
      return v.status === UPLOAD_STATUS.WAITING
    })
    return waitingUploadChunks.slice(0, freeThreads)
  }

  uploadChunk (chunk) {
    if (!chunk) {
      return
    }
    chunk.status = UPLOAD_STATUS.UPLOADING
    this._activeThreads++
    let xhr = new XMLHttpRequest()
    let fd = new FormData()

    fd.append(this.builtInFormDataNames.data, chunk.blob, this._file.name)
    fd.append(this.builtInFormDataNames.index, chunk.index)
    fd.append(this.builtInFormDataNames.length, this._chunks.length)
    fd.append(this.builtInFormDataNames.fileSize, this._file.size)
    fd.append(this.builtInFormDataNames.fileName, this._file.name)

    if (this.arrayBufferMd5Computer) {
      fd.append(this.builtInFormDataNames.md5, chunk.md5)
      fd.append(this.builtInFormDataNames.fileMd5, this._file.md5)
    }

    this.extraFormData.forEach((data) => {
      fd.append(data[0], data[1])
    })

    xhr.open(this.method, this.server)

    this.headers.forEach((header) => {
      xhr.setRequestHeader(header[0], header[1])
    })
    xhr.addEventListener('load', (e) => {
      if (chunk.timestamp !== this._timestamp) {
        return
      }
      chunk.status = UPLOAD_STATUS.SUCCESS
      this.triggerDone(e, chunk)
    }, false)
    xhr.upload.addEventListener('progress', (e) => {
      if (chunk.timestamp !== this._timestamp) {
        return
      }
      chunk.canTriggerProgress = true
      this.triggerProgress(chunk.blob.size, e.loaded, e.total)
    })
    xhr.addEventListener('error', (e) => {
      if (chunk.timestamp !== this._timestamp) {
        return
      }
      chunk.status = UPLOAD_STATUS.FAIL
      this.triggerError(e)
    }, false)
    xhr.addEventListener('abort', (e) => {
      if (chunk.timestamp !== this._timestamp) {
        return
      }
      chunk.status = UPLOAD_STATUS.FAIL
    }, false)
    xhr.addEventListener('loadend', (e) => {
      if (chunk.timestamp !== this._timestamp) {
        return
      }
      this._activeThreads--
      this.uploadChunks()
    }, false)
    xhr.send(fd)
  }

  triggerProgress (chunkSize, loaded, total) {
    this._totalLoaded = this._totalLoaded + Math.ceil(chunkSize * loaded / total)
    this.onProgress && this.onProgress(this.getPercent())
  }

  triggerError (code, message) {
    this.onError && this.onError(code, message)
  }

  triggerDone (e, chunk) {
    if (!chunk.canTriggerProgress) { // 增对不支持progress的设备
      this._totalLoaded = this._totalLoaded + chunk.blob.size
    }
    if (this._totalLoaded < this._file.size) {
      return
    }
    let response
    try {
      response = e.target.response ? JSON.parse(e.target.response) : ''
      this.onDone && this.onDone(response)
    } catch (e) {
      this.triggerError(ERROR_CODE.INVALID_SERVER_RESPONSE, '请返回JSON格式数据')
    }
  }

  getPercent () {
    if (!this._file || !this._file.size) {
      return 0
    }

    return Math.min(this._totalLoaded / this._file.size, 1)
  }

  reset (file) {
    this._file = file
    this._chunks = []
    this._totalLoaded = 0
    this._activeThreads = 0 // 激活的线程
    this._timestamp = Date.now()
  }

  check (file) {
    if (!file) {
      this.triggerError(ERROR_CODE.NO_SELECT_FILE, '请选择文件')
      return false
    }
    if (!this.server) {
      this.triggerError(ERROR_CODE.NO_SERVER, '未配置服务地址')
      return false
    }
    if (this.extensions.length) {
      let ext = getFileExt(file)
      let isValidExt = this.extensions.some(function (v) {
        return v.toLowerCase() === ext
      })
      if (!isValidExt) {
        this.triggerError(ERROR_CODE.INVALID_EXTENSION, '非法文件类型')
        return false
      }
    }
    if (this.fileSizeLimit && (file.size > this.fileSizeLimit)) {
      this.triggerError(ERROR_CODE.OVER_LIMIT_SIZE, '文件太大了')
      return false
    }
    return true
  }

  compressImage () {
    if (!this.imageAutoCompress) {
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      let canvas = document.createElement('canvas')
      let img = document.createElement('img')
      let reader = new FileReader()
      reader.addEventListener('load', () => {
        img.src = reader.result
      }, false)
      img.addEventListener('load', () => {
        let width
        let height
        let ctx = canvas.getContext('2d')
        let widthRatio = img.naturalWidth / this.compress.width
        let heightRatio = img.naturalHeight / this.compress.height
        if (widthRatio <= 1 && heightRatio <= 1) {
          return resolve()
        } else if (widthRatio >= heightRatio) {
          width = this.compress.width
          height = Math.round(width * img.naturalHeight / img.naturalWidth)
        } else {
          height = this.compress.height
          width = Math.round(height * img.naturalWidth / img.naturalHeight)
        }
        canvas.width = width
        canvas.height = height
        ctx.drawImage(img, 0, 0, width, height)

        canvas.toBlob((blob) => {
          blob.name = this._file.name
          this._file = blob
          resolve()
        }, this._file.type, this.compress.quality)
      }, false)
      reader.readAsDataURL(this._file)
    })
  }

  send (file) {
    if (this.check(file)) {
      this.reset(file)
      this.compressImage()
        .then(() => this.createChunks())
        .then(() => this.addChunksMd5Info())
        .then(() => this.uploadChunks())
    }
  }
}
