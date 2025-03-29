package main

import (
	// "compress/gzip"
	// "io"
	"log"
	"net/http"
	// "os"
	"path/filepath"
	"strings"
)

// http://localhost:8080/dash/index.mpd

func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		log.Println(r.Method, r.URL)
		// set cors
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, Content-Length")
		if r.Method == "OPTIONS" {
			return
		}

		next.ServeHTTP(w, r)
	})
}

// mimeTypes defines the MIME types for different file extensions.
var mimeTypes = map[string]string{
	".mpd":  "application/dash+xml",
	".m4s":  "video/iso.segment",
	".m4v":  "video/mp4",
	".mp4":  "video/mp4",
	".ply": "application/octet-stream",
	".bin": "application/octet-stream",
	".json": "application/json",
	// in this situation, gz are used to compress json
	// ".gz": "application/json",
}

// customFileServer serves files with correct MIME types.
func customFileServer(fs http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		ext := strings.ToLower(filepath.Ext(path))
		if contentType, ok := mimeTypes[ext]; ok {
			w.Header().Set("Content-Type", contentType)
			// compress json with gzip
			// if ext == ".json" && strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
			// 	// Serve the JSON file with Gzip compression
			// 	w.Header().Set("Content-Encoding", "gzip")
			// 	w.Header().Set("Content-Type", mimeTypes[ext])
				
			// 	filePath := filepath.Join(".", path)
			// 	file, err := os.Open(filePath)
			// 	if err != nil {
			// 		http.Error(w, "File not found", http.StatusNotFound)
			// 		return
			// 	}
			// 	defer file.Close()

			// 	// Create a gzip.Writer and copy the file content into it
			// 	gzWriter := gzip.NewWriter(w)
			// 	defer gzWriter.Close()

			// 	_, err = io.Copy(gzWriter, file)
			// 	if err != nil {
			// 		http.Error(w, "Failed to compress file", http.StatusInternalServerError)
			// 	}
			// 	return
			// }
		}
		fs.ServeHTTP(w, r)
	})
}

func main() {
	// set cors
	http.Handle("/localbackend/", corsMiddleware(customFileServer(http.FileServer(http.Dir("./")))))
	http.Handle("/webbackend/", corsMiddleware(customFileServer(http.FileServer(http.Dir("./")))))

	// http.Handle("/fragmented/", corsMiddleware(customFileServer(http.FileServer(http.Dir("./")))))
	// http.Handle("/singlefile/", corsMiddleware(customFileServer(http.FileServer(http.Dir("./")))))
	// http.Handle("/fragmented/", corsMiddleware(http.StripPrefix("/fragmented/", customFileServer(http.FileServer(http.Dir("./fragmented"))))))
	// http.Handle("/singlefile/", corsMiddleware(http.StripPrefix("/singlefile/", customFileServer(http.FileServer(http.Dir("./singlefile"))))))
	addr := ":8080"
	// addr := "0.0.0.0:8080"
	log.Println("Listening on ", addr)
	// print request
	err := http.ListenAndServe(addr, nil)
	if err != nil {
		log.Fatal(err)
	}
}
