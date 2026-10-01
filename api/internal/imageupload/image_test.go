package imageupload

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"testing"

	"github.com/stretchr/testify/require"
)

// Go x/image testdata/gopher-doc.1bpp.lossless.webp, BSD-licensed Go Authors.
const webpFixture = "UklGRrIBAABXRUJQVlA4TKUBAAAvSsAYAA8w//M///MfeJAkbXvaSG7m8Q3GfYSBJekwQztm/IcZlgwnmWImn2BK7aFmBtnVir6q//8VOkFE/xm4baTIu8c48ArEo6+B3zFKYln3pqClSCKX0begFTAXFOLXHSyF8cCNcZEG4OywuA4KVVfJCiArU7GAgJI8+lJP/OKMT/fBAjevg1cYB7YVkFuWga2lyPi5I0HFy5YTpWIHg0RZpkniRVW9odHAKOwosWuOGdxIyn2OvaCDvhg/we6TwadPBPbqBV58MsLmMJ8yZnOWk8SRz4N+QoyPL+MnamzMvcE1rHNEr91F9GKZPVUcS9w7PhhH36suB9qPeYb/oLk6cuTiJ0wOK3m5h1cKjW6EVZCYMK7dxcKCBdgP9HkKr9gkAO2P8GKZGWVdIAatQa+1IDpt6qyorVwdy01xdW8Jkfk6xjEXmVQQ+HQdFr6OKhIN34dXWq0+0qr6EJSCeeVLH9+gvGTLyqM65PQ44ihzlTXxQKjKbAvshXgir7Lil9w4L2bvMycmjQcqXaMCO6BlY28i+FOLzbfI1vEqxAhotocAAA=="

func encodedImage(t *testing.T, format string) []byte {
	t.Helper()
	m := image.NewNRGBA(image.Rect(0, 0, 3, 2))
	m.Set(0, 0, color.NRGBA{255, 20, 40, 255})
	m.Set(2, 1, color.NRGBA{10, 220, 40, 255})
	var buf bytes.Buffer
	if format == "png" {
		require.NoError(t, png.Encode(&buf, m))
	} else {
		require.NoError(t, jpeg.Encode(&buf, m, &jpeg.Options{Quality: 93}))
	}
	return buf.Bytes()
}
func assertSamePixels(t *testing.T, before, after []byte) {
	t.Helper()
	a, _, err := image.Decode(bytes.NewReader(before))
	require.NoError(t, err)
	b, _, err := image.Decode(bytes.NewReader(after))
	require.NoError(t, err)
	require.Equal(t, a.Bounds(), b.Bounds())
	for y := a.Bounds().Min.Y; y < a.Bounds().Max.Y; y++ {
		for x := a.Bounds().Min.X; x < a.Bounds().Max.X; x++ {
			require.Equal(t, color.NRGBAModel.Convert(a.At(x, y)), color.NRGBAModel.Convert(b.At(x, y)))
		}
	}
}
func TestPNGMetadataIsStrippedLosslessly(t *testing.T) {
	original := encodedImage(t, "png")
	data := append([]byte{}, original[:33]...)
	data = append(data, pngChunk("tEXt", []byte("GPS\x00private-location"))...)
	data = append(data, pngChunk("eXIf", append(orientationEXIF(6), []byte("private-device")...))...)
	data = append(data, original[33:]...)
	out, err := Sanitize(data)
	require.NoError(t, err)
	require.Equal(t, "image/png", out.ContentType)
	require.Equal(t, 3, out.Width)
	require.Equal(t, 2, out.Height)
	require.NotContains(t, string(out.Data), "private")
	require.Contains(t, string(out.Data), "eXIf")
	assertSamePixels(t, data, out.Data)
	again, err := Sanitize(out.Data)
	require.NoError(t, err)
	require.Equal(t, out.Data, again.Data)
}
func TestJPEGOrientationAndCompressedPixelsPreserved(t *testing.T) {
	for o := uint16(1); o <= 8; o++ {
		t.Run(string(rune('0'+o)), func(t *testing.T) {
			original := encodedImage(t, "jpeg")
			ex := append([]byte("Exif\x00\x00"), orientationEXIF(o)...)
			ex = append(ex, []byte("private GPS and device")...)
			data := append([]byte{}, original[:2]...)
			data = append(data, 255, 225, byte((len(ex)+2)>>8), byte(len(ex)+2))
			data = append(data, ex...)
			data = append(data, 255, 254, 0, 9)
			data = append(data, []byte("private")...)
			data = append(data, original[2:]...)
			out, err := Sanitize(data)
			require.NoError(t, err)
			require.NotContains(t, string(out.Data), "private")
			pos := bytes.Index(out.Data, []byte("Exif\x00\x00"))
			require.GreaterOrEqual(t, pos, 0)
			got, err := orientation(out.Data[pos : pos+32])
			require.NoError(t, err)
			require.Equal(t, o, got)
			assertSamePixels(t, data, out.Data)
			again, err := Sanitize(out.Data)
			require.NoError(t, err)
			require.Equal(t, out.Data, again.Data)
		})
	}
}
func TestWebPValidAndMetadataFiltered(t *testing.T) {
	raw, err := base64.StdEncoding.DecodeString(webpFixture)
	require.NoError(t, err)
	clean, err := Sanitize(raw)
	require.NoError(t, err)
	require.Equal(t, "image/webp", clean.ContentType)
	extended := append([]byte{}, raw[:12]...)
	vp := make([]byte, 10)
	vp[0] = 12
	w, h := clean.Width-1, clean.Height-1
	vp[4] = byte(w)
	vp[5] = byte(w >> 8)
	vp[6] = byte(w >> 16)
	vp[7] = byte(h)
	vp[8] = byte(h >> 8)
	vp[9] = byte(h >> 16)
	extended = append(extended, riffChunk("VP8X", vp)...)
	extended = append(extended, raw[12:]...)
	extended = append(extended, riffChunk("EXIF", append(orientationEXIF(8), []byte("private-device")...))...)
	extended = append(extended, riffChunk("XMP ", []byte("private-GPS"))...)
	binary.LittleEndian.PutUint32(extended[4:8], uint32(len(extended)-8))
	out, err := Sanitize(extended)
	require.NoError(t, err)
	require.NotContains(t, string(out.Data), "private")
	require.Equal(t, byte(8), out.Data[20]&12)
	assertSamePixels(t, extended, out.Data)
	again, err := Sanitize(out.Data)
	require.NoError(t, err)
	require.Equal(t, out.Data, again.Data)
}
func TestInvalidAndOversizedImages(t *testing.T) {
	for _, data := range [][]byte{nil, []byte("<svg onload='alert(1)'/>"), []byte("GIF89a"), append(encodedImage(t, "png"), []byte("trailing")...), encodedImage(t, "jpeg")[:25]} {
		_, err := Sanitize(data)
		require.ErrorIs(t, err, ErrInvalid)
	}
	_, err := Sanitize(make([]byte, MaxBytes+1))
	require.ErrorIs(t, err, ErrLimit)
	original := encodedImage(t, "png")
	header := append([]byte{}, original[16:29]...)
	binary.BigEndian.PutUint32(header[:4], 5000)
	binary.BigEndian.PutUint32(header[4:8], 5000)
	huge := append([]byte{}, original[:8]...)
	huge = append(huge, pngChunk("IHDR", header)...)
	huge = append(huge, original[33:]...)
	_, err = Sanitize(huge)
	require.ErrorIs(t, err, ErrLimit)
	malformed := append([]byte{}, original[:33]...)
	malformed = append(malformed, pngChunk("eXIf", []byte("bad TIFF"))...)
	malformed = append(malformed, original[33:]...)
	_, err = Sanitize(malformed)
	require.ErrorIs(t, err, ErrInvalid)
}
func FuzzSanitize(f *testing.F) {
	var b bytes.Buffer
	_ = png.Encode(&b, image.NewRGBA(image.Rect(0, 0, 2, 2)))
	f.Add(b.Bytes())
	f.Add([]byte("not image"))
	f.Fuzz(func(t *testing.T, data []byte) {
		out, err := Sanitize(data)
		if err == nil {
			require.LessOrEqual(t, len(out.Data), MaxBytes)
			require.LessOrEqual(t, int64(out.Width)*int64(out.Height), int64(MaxPixels))
			_, _, err := image.Decode(bytes.NewReader(out.Data))
			require.NoError(t, err)
		}
	})
}

func TestDecodeConcurrencyWaitCanBeCancelled(t *testing.T) {
	decodeSlots <- struct{}{}
	decodeSlots <- struct{}{}
	defer func() { <-decodeSlots; <-decodeSlots }()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := SanitizeContext(ctx, encodedImage(t, "png"))
	require.ErrorIs(t, err, context.Canceled)
}

func TestExactInputBoundaryAndAnimatedPNGRejection(t *testing.T) {
	original := encodedImage(t, "png")
	data := append([]byte{}, original[:33]...)
	data = append(data, pngChunk("tEXt", bytes.Repeat([]byte{'x'}, MaxBytes-len(original)-12))...)
	data = append(data, original[33:]...)
	require.Len(t, data, MaxBytes)
	out, err := Sanitize(data)
	require.NoError(t, err)
	require.Equal(t, original, out.Data)
	animated := append([]byte{}, original[:33]...)
	animated = append(animated, pngChunk("acTL", make([]byte, 8))...)
	animated = append(animated, original[33:]...)
	_, err = Sanitize(animated)
	require.ErrorIs(t, err, ErrInvalid)
}

func TestDecodeSlotsRejectOverloadAndHonorCancellation(t *testing.T) {
	require.Equal(t, 2, cap(decodeSlots))
	decodeSlots <- struct{}{}
	decodeSlots <- struct{}{}
	t.Cleanup(func() { <-decodeSlots; <-decodeSlots })
	_, err := SanitizeContext(t.Context(), encodedImage(t, "png"))
	require.ErrorIs(t, err, ErrBusy)
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	_, err = SanitizeContext(ctx, encodedImage(t, "png"))
	require.ErrorIs(t, err, context.Canceled)
	<-decodeSlots
	_, err = SanitizeContext(t.Context(), []byte("bad image"))
	require.ErrorIs(t, err, ErrInvalid)
	require.Equal(t, 1, len(decodeSlots), "failed decodes release their slot")
	_, err = SanitizeContext(ctx, encodedImage(t, "png"))
	require.ErrorIs(t, err, context.Canceled, "cancellation wins even when a slot is available")
	decodeSlots <- struct{}{}
}

func TestAnimationAndWebPHiddenFrameLimits(t *testing.T) {
	pngData := encodedImage(t, "png")
	animated := append([]byte{}, pngData[:33]...)
	animated = append(animated, pngChunk("acTL", make([]byte, 8))...)
	animated = append(animated, pngData[33:]...)
	_, err := Sanitize(animated)
	require.ErrorIs(t, err, ErrInvalid)
	raw, err := base64.StdEncoding.DecodeString(webpFixture)
	require.NoError(t, err)
	for _, kind := range []string{"ANIM", "ANMF"} {
		data := append(append([]byte{}, raw...), riffChunk(kind, make([]byte, 16))...)
		binary.LittleEndian.PutUint32(data[4:8], uint32(len(data)-8))
		_, err = Sanitize(data)
		require.ErrorIs(t, err, ErrInvalid)
	}
	duplicate := append(append([]byte{}, raw...), raw[12:]...)
	binary.LittleEndian.PutUint32(duplicate[4:8], uint32(len(duplicate)-8))
	_, err = Sanitize(duplicate)
	require.ErrorIs(t, err, ErrInvalid)
	// A declared 1x1 canvas must not conceal the actual 75x100 frame.
	vp8x := make([]byte, 10)
	extended := append([]byte{}, raw[:12]...)
	extended = append(extended, riffChunk("VP8X", vp8x)...)
	extended = append(extended, raw[12:]...)
	binary.LittleEndian.PutUint32(extended[4:8], uint32(len(extended)-8))
	_, err = Sanitize(extended)
	require.ErrorIs(t, err, ErrInvalid)
	// Forge the lossless frame header to 5000x5000 while keeping VP8X tiny.
	// The frame header is checked before any full pixel allocation.
	bits := uint32(4999) | uint32(4999)<<14
	binary.LittleEndian.PutUint32(extended[39:43], bits)
	_, err = Sanitize(extended)
	require.ErrorIs(t, err, ErrLimit)
}
