/*
Represents a connection (both client and server sides)
*/

var util = require("util")
var events = require("events")
var crypto = require("crypto")
var InStream = require("./InStream.js")
var OutStream = require("./OutStream.js")
var frame = require("./frame.js")
var Server = require("./Server.js")

// socket is a net or tls socket
// parent can be a Server or, in case of client connection, a string with the path to connect to
// callback will be added as a listener to "connect"
// Events: close(code, reason), error(err), text(str), binary(inStream), connect()
function Connection(socket, parent, callback) {
	var that = this
	
	this.socket = socket
	this.server = typeof parent == "string" ? null : parent
	this.readyState = this.CONNECTING
	this.buffer = "" // string before handshake, Buffer after that
	this.frameBuffer = null // string for text frames and InStream for binary frames
	this.outStream = null // current allocated OutStream object for sending binary frames
	this.path = typeof parent == "string" ? parent : null
	this.key = null // the Sec-WebSocket-Key header
	
	// Set listeners
	socket.on("readable", function () {
		that.doRead()
	})
	socket.on("close", function () {
		var pos
		if (that.readyState == that.CONNECTING || that.readyState == that.OPEN)
			that.emit("close", 1006, "")
		that.readyState = this.CLOSED
		if (that.frameBuffer instanceof InStream) {
			that.frameBuffer.end()
			that.frameBuffer = null
		}
		if (that.outStream instanceof OutStream) {
			that.outStream.end()
			that.outStream = null
		}
	})
	socket.on("error", function (err) {
		that.emit("error", err)
	})
	if (!this.server)
		socket.on("connect", function () {
			that.startHandshake()
		})
	
	// super constructor
	events.EventEmitter.call(this)
	this.on("connect", callback)
}

// Minimum size of a pack of binary data to send in a single frame
Connection.binaryFragmentation = 512*1024 // .5 MiB

// Makes Connection also an EventEmitter
util.inherits(Connection, events.EventEmitter)

// Possible ready states for the connection
Connection.prototype.CONNECTING = 0
Connection.prototype.OPEN = 1
Connection.prototype.CLOSING = 2
Connection.prototype.CLOSED = 3

// Send a given string to the other side
// callback is an optional function that will be executed when the data is finally written out
Connection.prototype.sendText = function (str, callback) {
	if (this.readyState == this.OPEN) {
		if (!this.outStream)
			return this.socket.write(frame.createTextFrame(str, !this.server), callback)
		this.emit("error", new Error("You can't send a text frame until you finish sending binary frames"))
	}
	this.emit("error", new Error("You can't write to a non-open connection"))
}

// Request for a OutStream to send binary data
Connection.prototype.beginBinary = function () {
	if (this.readyState == this.OPEN) {
		if (!this.outStream)
			return this.outStream = new OutStream(this, Connection.binaryFragmentation)
		this.emit("error", new Error("You can't send more binary frames until you finish sending the previous binary frames"))
	}
	this.emit("error", new Error("You can't write to a non-open connection"))
}

// Sends a binary buffer at once
// callback is an optional function that will be executed when the data is finally written out
Connection.prototype.sendBinary = function (data, callback) {
	if (this.readyState == this.OPEN) {
		if (!this.outStream)
			return this.socket.write(frame.createBinaryFrame(data, !this.server, true, true), callback)
		this.emit("error", new Error("You can't send more binary frames until you finish sending the previous binary frames"))
	}
	this.emit("error", new Error("You can't write to a non-open connection"))
}

// Close the connection, sending a close frame and waiting for response
// If the connection isn't OPEN, closes it without sending a close frame
// code is an int (optional)
// reason is a string (optional)
Connection.prototype.close = function (code, reason) {
	if (this.readyState == this.OPEN) {
		this.socket.write(frame.createCloseFrame(code, reason, !this.server))
		this.readyState = this.CLOSING
	} else if (this.readyState != this.CLOSED) {
		this.socket.end()
		this.readyState = this.CLOSED
	}
	this.emit("close", code, reason)
}

// Reads contents from the socket and process it
Connection.prototype.doRead = function () {
	var buffer, temp
	
	// Fetches the data
	buffer = this.socket.read()
	if (!buffer)
		// Waits for more data
		return
	
	if (this.readyState == this.CONNECTING) {
		// Do the handshake and try to connect
		this.buffer += buffer.toString()
		if (this.buffer.substr(-4) != "\r\n\r\n")
			// Wait for more data
			return
		temp = this.buffer.split("\r\n")
		if (this.server ? this.answerHandshake(temp) : this.checkHandshake(temp)) {
			this.buffer = new Buffer(0)
			this.readyState = this.OPEN
			this.emit("connect")
		} else
			this.socket.end(this.server ? "HTTP/1.1 400 Bad Request\r\n\r\n" : undefined)
	} else if (this.readyState != this.CLOSED) {
		// Save to the internal buffer and try to read as many frames as possible
		this.buffer = Buffer.concat([this.buffer, buffer], this.buffer.length+buffer.length)
		while ((temp=this.extractFrame()) === true);
		if (temp === false)
			this.close(1002)
	}
}

// Create and send a handshake as a client
Connection.prototype.startHandshake = function () {
	var str, i, key
	key = new Buffer(16)
	for (i=0; i<16; i++)
		key[i] = Math.floor(Math.random()*256)
	this.key = key.toString("base64")
	str = "GET "+this.path+" HTTP/1.1\r\n"+
		"Host: "+this.parent+"\r\n"+
		"Upgrade: websocket\r\n"+
		"Connection: Upgrade\r\n"+
		"Sec-WebSocket-Key: "+this.key+"\r\n"+
		"Sec-WebSocket-Version: 13\r\n\r\n"
	this.socket.write(str)
}

// Process and check a handshake answered by a server
// lines is an Array of strings (one for each "\r\n"-separated HTTP request line)
// Returns if the handshake was sucessful
// If not, the connection must be closed
Connection.prototype.checkHandshake = function (lines) {
	var headers, i, temp, key, response, sha1
	
	// First line
	if (lines.length < 4)
		return false
	if (!lines[0].match(/^HTTP\/\d\.\d 101( .*)?$/i))
		return false
	
	// Extract all headers
	headers = {}
	for (i=1; i<lines.length; i++) {
		if (!lines[i].trim())
			continue
		temp = lines[i].match(/^([a-z-]+): (.+)$/i)
		if (!temp)
			return false
		headers[temp[1].toLowerCase()] = temp[2]
	}
	
	// Validate necessary headers
	if (!("upgrade" in headers) || !("sec-websocket-accept" in headers) || !("connection" in headers))
		return false
	if (headers.upgrade.toLowerCase() != "websocket" || headers.connection.toLowerCase().split(", ").indexOf("upgrade") == -1)
		return false
	key = headers["sec-websocket-accept"]
	
	// Check the key
	sha1 = crypto.createHash("sha1")
	sha1.end(this.key+"258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
	if (key != sha1.read().toString("base64"))
		return false
	return true
}

// Process and answer a handshake started by a client
// lines is an Array of strings (one for each "\r\n"-separated HTTP request line)
// Returns if the handshake was sucessful
// If not, the connection must be closed with error 400-Bad Request
Connection.prototype.answerHandshake = function (lines) {
	var path, headers, i, temp, key, response, sha1
	
	// First line
	if (lines.length < 6)
		return false
	path = lines[0].match(/^GET (.+) HTTP\/\d\.\d$/i)
	if (!path)
		return false
	this.path = path[1]
	
	// Extract all headers
	headers = {}
	for (i=1; i<lines.length; i++) {
		if (!lines[i].trim())
			continue
		temp = lines[i].match(/^([a-z-]+): (.+)$/i)
		if (!temp)
			return false
		headers[temp[1].toLowerCase()] = temp[2]
	}
	
	// Validate necessary headers
	if (!("host" in headers) || !("sec-websocket-key" in headers))
		return false
	if (headers.upgrade.toLowerCase() != "websocket" || headers.connection.toLowerCase().split(", ").indexOf("upgrade") == -1)
		return false
	if (headers["sec-websocket-version"] != "13")
		return false

	this.key = headers["sec-websocket-key"]
	
	// Build and send the response
	sha1 = crypto.createHash("sha1")
	sha1.end(this.key+"258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
	key = sha1.read().toString("base64")
	this.socket.write("HTTP/1.1 101 Switching Protocols\r\n"+
		"Upgrade: websocket\r\n"+
		"Connection: Upgrade\r\n"+
		"Sec-WebSocket-Accept: "+key+"\r\n\r\n")
	return true
}

// Try to extract frame contents from the buffer (and execute it)
// Returns false in case something went wrong. The connection must be closed then
// Returns undefined in case there isn't enough data to catch a frame
// Returns true in case the frame was successfully fetched and executed
Connection.prototype.extractFrame = function () {
	var fin, opcode, B, HB, mask, len, payload, start, mask, i
	
	if (this.buffer.length < 2)
		return
	
	// Is this the last frame in a sequence?
	B = this.buffer[0]
	HB = B>>4
	if (HB%8)
		// RSV1, RSV2 and RSV3 must be clear
		return false
	fin = HB==8
	opcode = B%16
	
	if (opcode != 0 && opcode != 1 && opcode != 2 && opcode != 8 && opcode != 9 && opcode != 10)
		// Invalid opcode
		return false
	if (opcode >= 8 && !fin)
		// Control frames must not be fragmented
		return false
	
	B = this.buffer[1]
	hasMask = B>>7
	if ((this.server && !hasMask) || (!this.server && hasMask))
		// Frames sent by clients must be masked
		return false
	len = B%128
	start = hasMask ? 6 : 2
	
	if (this.buffer.length < start+len)
		// Not enough data in the buffer
		return
	
	// Get the actual payload length
	if (len == 126) {
		len = this.buffer.readUInt16BE(2)
		start += 2
	} else if (len == 127) {
		// Warning: JS can only store up to 2^53 in its number format
		len = this.buffer.readUInt32BE(2)*Math.pow(2, 32)+this.buffer.readUInt32BE(6)
		start += 8
	}
	if (this.buffer.length < start+len)
		return
	
	// Extract the payload
	payload = this.buffer.slice(start, start+len)
	if (hasMask) {
		// Decode with the given mask
		mask = this.buffer.slice(start-4, start)
		for (i=0; i<payload.length; i++)
			payload[i] ^= mask[i%4]
	}
	this.buffer = this.buffer.slice(start+len)
	
	// Proceeds to frame processing
	return this.processFrame(fin, opcode, payload)
}

// Process a given frame received
// Returns false if any error occurs, true otherwise
Connection.prototype.processFrame = function (fin, opcode, payload) {
	if (opcode == 8) {
		// Close frame
		if (this.readyState == this.CLOSING)
			this.socket.end()
		else if (this.readyState == this.OPEN)
			this.processCloseFrame(payload)
		return true
	} else if (opcode == 9) {
		// Ping frame
		if (this.readyState == this.OPEN)
			this.socket.write(frame.createPongFrame(payload.toString(), !this.server))
		return true
	} else if (opcode == 10)
		// Pong frame
		return true
	
	if (this.readyState != this.OPEN)
		// Ignores if the connection isn't opened anymore
		return true
	
	if (opcode == 0 && this.frameBuffer === null)
		// Unexpected continuation frame
		return false
	else if (opcode != 0 && this.frameBuffer !== null)
		// Last sequence didn't finished correctly
		return false
	
	if (!opcode)
		// Get the current opcode for fragmented frames
		opcode = typeof this.frameBuffer == "string" ? 1 : 2
	
	if (opcode == 1) {
		// Save text frame
		payload = payload.toString()
		this.frameBuffer = this.frameBuffer ? this.frameBuffer+payload : payload
		
		if (fin) {
			// Emits "text" event
			this.emit("text", this.frameBuffer)
			this.frameBuffer = null
		}
	} else {
		// Sends the buffer for InStream object
		if (!this.frameBuffer) {
			// Emits the "binary" event
			this.frameBuffer = new InStream
			this.emit("binary", this.frameBuffer)
		}
		this.frameBuffer.addData(payload)
		
		if (fin) {
			// Emits "end" event
			this.frameBuffer.end()
			this.frameBuffer = null
		}
	}
	
	return true
}

// Process a close frame, emitting the close event and sending back the frame
Connection.prototype.processCloseFrame = function (payload) {
	var code, reason
	if (payload.length >= 2) {
		code = payload.readUInt16BE(0)
		reason = payload.slice(2).toString()
	} else {
		code = 1005
		reason = ""
	}
	this.socket.write(frame.createCloseFrame(code, reason, !this.server))
	this.readyState = this.CLOSED
	this.emit("close", code, reason)
}

module.exports = Connection