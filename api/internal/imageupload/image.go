package imageupload

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"hash/crc32"
	"image"
	_ "image/jpeg"
	_ "image/png"

	_ "golang.org/x/image/webp"
)

const MaxBytes = 10 << 20
const MaxPixels = 20_000_000

var ErrInvalid = errors.New("invalid PNG, JPEG or WebP image")
var ErrLimit = errors.New("image exceeds 10 MiB or 20 megapixels")
var ErrBusy = errors.New("image processing is busy, retry shortly")

type Image struct {
	Data          []byte
	ContentType   string
	Width, Height int
}

// Sanitize validates dimensions, filters containers, then decodes pixels. Keeping the
// compressed pixel stream and color profiles avoids another lossy generation.
// EXIF is replaced with only its orientation tag, never copied wholesale.
var decodeSlots = make(chan struct{}, 2)

func Sanitize(data []byte) (Image, error) {
	return SanitizeContext(context.Background(), data)
}

func SanitizeContext(ctx context.Context, data []byte) (Image, error) {
	if err := ctx.Err(); err != nil {
		return Image{}, err
	}
	select {
	case decodeSlots <- struct{}{}:
		defer func() { <-decodeSlots }()
	case <-ctx.Done():
		return Image{}, ctx.Err()
	default:
		return Image{}, ErrBusy
	}
	if len(data) > MaxBytes {
		return Image{}, ErrLimit
	}
	cfg, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return Image{}, ErrInvalid
	}
	if cfg.Width <= 0 || cfg.Height <= 0 || int64(cfg.Width)*int64(cfg.Height) > MaxPixels {
		return Image{}, ErrLimit
	}
	if format != "png" && format != "jpeg" && format != "webp" {
		return Image{}, ErrInvalid
	}
	var out []byte
	switch format {
	case "png":
		out, err = stripPNG(data)
	case "jpeg":
		out, err = stripJPEG(data)
	case "webp":
		out, err = stripWebP(data)
	}
	if err != nil {
		return Image{}, err
	}
	if len(out) > MaxBytes {
		return Image{}, ErrLimit
	}
	decoded, _, err := image.Decode(bytes.NewReader(out))
	if err != nil || decoded.Bounds().Dx() != cfg.Width || decoded.Bounds().Dy() != cfg.Height {
		return Image{}, ErrInvalid
	}
	return Image{Data: out, ContentType: "image/" + format, Width: cfg.Width, Height: cfg.Height}, nil
}

// Read only the bounded primary TIFF IFD. All pointers, private tags, thumbnail
// IFDs, GPS and maker notes are discarded rather than recursively traversed.
func orientation(exif []byte) (uint16, error) {
	if bytes.HasPrefix(exif, []byte("Exif\x00\x00")) {
		exif = exif[6:]
	}
	if len(exif) < 8 {
		return 0, ErrInvalid
	}
	var order binary.ByteOrder
	switch string(exif[:2]) {
	case "II":
		order = binary.LittleEndian
	case "MM":
		order = binary.BigEndian
	default:
		return 0, ErrInvalid
	}
	if order.Uint16(exif[2:4]) != 42 {
		return 0, ErrInvalid
	}
	offset := uint64(order.Uint32(exif[4:8]))
	if offset+2 > uint64(len(exif)) {
		return 0, ErrInvalid
	}
	n := uint64(order.Uint16(exif[offset : offset+2]))
	if offset+2+n*12+4 > uint64(len(exif)) {
		return 0, ErrInvalid
	}
	var result uint16
	for i := uint64(0); i < n; i++ {
		p := offset + 2 + i*12
		tag := exif[p : p+12]
		if order.Uint16(tag[:2]) == 0x112 {
			if result != 0 || order.Uint16(tag[2:4]) != 3 || order.Uint32(tag[4:8]) != 1 {
				return 0, ErrInvalid
			}
			result = order.Uint16(tag[8:10])
			if result < 1 || result > 8 {
				return 0, ErrInvalid
			}
		}
	}
	return result, nil
}
func orientationEXIF(o uint16) []byte {
	out := []byte{'I', 'I', 42, 0, 8, 0, 0, 0, 1, 0, 0x12, 1, 3, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0}
	binary.LittleEndian.PutUint16(out[18:20], o)
	return out
}
func pngChunk(kind string, data []byte) []byte {
	out := make([]byte, 12+len(data))
	binary.BigEndian.PutUint32(out, uint32(len(data)))
	copy(out[4:8], kind)
	copy(out[8:], data)
	binary.BigEndian.PutUint32(out[len(out)-4:], crc32.ChecksumIEEE(out[4:len(out)-4]))
	return out
}
func stripPNG(data []byte) ([]byte, error) {
	if len(data) < 8 {
		return nil, ErrInvalid
	}
	out := append([]byte{}, data[:8]...)
	seenOrientation := false
	for p := 8; p < len(data); {
		if len(data)-p < 12 {
			return nil, ErrInvalid
		}
		n := int(binary.BigEndian.Uint32(data[p : p+4]))
		if n > len(data)-p-12 {
			return nil, ErrInvalid
		}
		kind := string(data[p+4 : p+8])
		chunk := data[p : p+n+12]
		payload := data[p+8 : p+8+n]
		if crc32.ChecksumIEEE(chunk[4:len(chunk)-4]) != binary.BigEndian.Uint32(chunk[len(chunk)-4:]) {
			return nil, ErrInvalid
		}
		switch kind {
		case "IHDR", "PLTE", "IDAT", "IEND", "tRNS", "cHRM", "gAMA", "iCCP", "sRGB", "sBIT":
			out = append(out, chunk...)
		case "eXIf":
			if seenOrientation {
				return nil, ErrInvalid
			}
			seenOrientation = true
			o, err := orientation(payload)
			if err != nil {
				return nil, err
			}
			if o != 0 {
				out = append(out, pngChunk("eXIf", orientationEXIF(o))...)
			}
		case "acTL", "fcTL", "fdAT":
			return nil, ErrInvalid // Animated uploads are explicitly unsupported.
		default:
			if kind[0]&32 == 0 {
				return nil, ErrInvalid
			}
		}
		p += n + 12
		if kind == "IEND" {
			if p != len(data) {
				return nil, ErrInvalid
			}
			return out, nil
		}
	}
	return nil, ErrInvalid
}
func stripJPEG(data []byte) ([]byte, error) {
	if len(data) < 4 || data[0] != 255 || data[1] != 216 {
		return nil, ErrInvalid
	}
	out := []byte{255, 216}
	seenOrientation := false
	for p := 2; p < len(data); {
		start := p
		if data[p] != 255 {
			return nil, ErrInvalid
		}
		for p < len(data) && data[p] == 255 {
			p++
		}
		if p >= len(data) {
			return nil, ErrInvalid
		}
		marker := data[p]
		p++
		if marker == 217 {
			out = append(out, 255, 217)
			if p != len(data) {
				return nil, ErrInvalid
			}
			return out, nil
		}
		if marker == 0 || marker == 216 || marker >= 208 && marker <= 215 {
			return nil, ErrInvalid
		}
		if len(data)-p < 2 {
			return nil, ErrInvalid
		}
		n := int(binary.BigEndian.Uint16(data[p : p+2]))
		if n < 2 || n > len(data)-p {
			return nil, ErrInvalid
		}
		payload := data[p+2 : p+n]
		end := p + n
		keep := marker < 224 || marker > 239
		if marker == 254 {
			keep = false
		}
		if marker == 224 && bytes.HasPrefix(payload, []byte("JFIF\x00")) { // JFIF density only, discard optional thumbnail.
			if len(payload) < 14 {
				return nil, ErrInvalid
			}
			fixed := append([]byte{}, payload[:14]...)
			fixed[12] = 0
			fixed[13] = 0
			out = append(out, 255, 224, 0, 16)
			out = append(out, fixed...)
		}
		if marker == 238 && bytes.HasPrefix(payload, []byte("Adobe")) && len(payload) == 12 {
			keep = true
		}
		if marker == 226 && bytes.HasPrefix(payload, []byte("ICC_PROFILE\x00")) {
			keep = true
		}
		if marker == 225 && bytes.HasPrefix(payload, []byte("Exif\x00\x00")) {
			if seenOrientation {
				return nil, ErrInvalid
			}
			seenOrientation = true
			o, err := orientation(payload)
			if err != nil {
				return nil, err
			}
			if o != 0 {
				ex := append([]byte("Exif\x00\x00"), orientationEXIF(o)...)
				out = append(out, 255, 225, 0, byte(len(ex)+2))
				out = append(out, ex...)
			}
		}
		if keep {
			out = append(out, data[start:end]...)
		}
		p = end
		if marker == 218 { // Keep entropy-coded scan bytes, including stuffed FF and restart markers.
			scan := p
			for p < len(data) {
				if data[p] != 255 {
					p++
					continue
				}
				q := p + 1
				for q < len(data) && data[q] == 255 {
					q++
				}
				if q >= len(data) {
					return nil, ErrInvalid
				}
				if data[q] == 0 || data[q] >= 208 && data[q] <= 215 {
					p = q + 1
					continue
				}
				break
			}
			out = append(out, data[scan:p]...)
		}
	}
	return nil, ErrInvalid
}
func riffChunk(kind string, payload []byte) []byte {
	out := make([]byte, 8+len(payload)+len(payload)%2)
	copy(out, kind)
	binary.LittleEndian.PutUint32(out[4:8], uint32(len(payload)))
	copy(out[8:], payload)
	return out
}
func stripWebP(data []byte) ([]byte, error) {
	if len(data) < 12 || string(data[:4]) != "RIFF" || string(data[8:12]) != "WEBP" || uint64(binary.LittleEndian.Uint32(data[4:8]))+8 != uint64(len(data)) {
		return nil, ErrInvalid
	}
	out := append([]byte{}, data[:12]...)
	vp8x := -1
	hasEXIF := false
	seenEXIF := false
	frames := 0
	var canvasWidth, canvasHeight, frameWidth, frameHeight int
	for p := 12; p < len(data); {
		if len(data)-p < 8 {
			return nil, ErrInvalid
		}
		n := int(binary.LittleEndian.Uint32(data[p+4 : p+8]))
		if n > len(data)-p-8 {
			return nil, ErrInvalid
		}
		end := p + 8 + n + n%2
		if end > len(data) {
			return nil, ErrInvalid
		}
		kind := string(data[p : p+4])
		payload := data[p+8 : p+8+n]
		switch kind {
		case "VP8X":
			if n != 10 || vp8x != -1 || p != 12 || payload[0]&0xc3 != 0 || payload[1] != 0 || payload[2] != 0 || payload[3] != 0 {
				return nil, ErrInvalid
			}
			canvasWidth = 1 + int(payload[4]) + int(payload[5])<<8 + int(payload[6])<<16
			canvasHeight = 1 + int(payload[7]) + int(payload[8])<<8 + int(payload[9])<<16
			if int64(canvasWidth)*int64(canvasHeight) > MaxPixels {
				return nil, ErrLimit
			}
			vp8x = len(out) + 8
			out = append(out, data[p:end]...)
			out[vp8x] &= ^(byte(8 | 4))
		case "VP8 ", "VP8L":
			frames++
			if frames != 1 {
				return nil, ErrInvalid
			}
			// DecodeConfig on only the compressed frame prevents a small VP8X
			// canvas from concealing a huge frame allocated by the full decoder.
			frame := append([]byte{}, data[:12]...)
			frame = append(frame, data[p:end]...)
			binary.LittleEndian.PutUint32(frame[4:8], uint32(len(frame)-8))
			cfg, _, err := image.DecodeConfig(bytes.NewReader(frame))
			if err != nil {
				return nil, ErrInvalid
			}
			frameWidth, frameHeight = cfg.Width, cfg.Height
			if int64(frameWidth)*int64(frameHeight) > MaxPixels {
				return nil, ErrLimit
			}
			out = append(out, data[p:end]...)
		case "ALPH", "ICCP":
			out = append(out, data[p:end]...)
		case "EXIF":
			if seenEXIF {
				return nil, ErrInvalid
			}
			seenEXIF = true
			o, err := orientation(payload)
			if err != nil {
				return nil, err
			}
			if o != 0 {
				hasEXIF = true
				out = append(out, riffChunk("EXIF", orientationEXIF(o))...)
			}
		case "ANIM", "ANMF":
			return nil, ErrInvalid
		}
		p = end
	}
	if frames != 1 || vp8x >= 0 && (canvasWidth != frameWidth || canvasHeight != frameHeight) {
		return nil, ErrInvalid
	}
	if hasEXIF {
		if vp8x < 0 {
			return nil, ErrInvalid
		}
		out[vp8x] |= 8
	}
	binary.LittleEndian.PutUint32(out[4:8], uint32(len(out)-8))
	return out, nil
}
