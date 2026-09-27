// qr-decode.swift — 用 macOS 內建的 Vision 框架解 QR Code（v3.6.5 驗證用）
//
// 為什麼需要這支：本專案的 QR 產生器是手寫的（不放前端外部套件），
// 如果只用自己寫的程式檢查自己的輸出，等於自己驗自己——所以改用系統的
// 影像辨識當「第三方解碼器」：能解出來、內容正確，才代表產生的碼真的可掃。
//
// 用法：
//   swift scripts/qr-decode.swift <圖片路徑>
//   swift scripts/qr-decode.swift -     # 從 stdin 讀 base64（或 data:image/...;base64,）
//
// v3.8.0：新增 stdin 模式。檢查腳本一律不得自己寫圖檔（見 no-screenshot-check），
// 但海報 canvas 的 QR 又必須用獨立解碼器驗，所以改成把 base64 用管線餵進來，
// 完全不需要落地任何檔案。
//
// 輸出：每個解出的內容一行；解不到任何碼時 exit code 1。
//
// 這支只在開發／測試時用（由 tests/qr.test.js 等呼叫），不進正式站執行路徑。

import Foundation
import Vision
import AppKit

let args = CommandLine.arguments
guard args.count > 1 else {
    FileHandle.standardError.write("用法：swift scripts/qr-decode.swift <圖片路徑|->（- 代表從 stdin 讀 base64）\n".data(using: .utf8)!)
    exit(2)
}

var image: NSImage?

if args[1] == "-" {
    let raw = String(data: FileHandle.standardInput.readDataToEndOfFile(), encoding: .utf8) ?? ""
    // 允許直接貼 data:image/png;base64,... 或只貼 base64 本體
    let base64 = raw.contains("base64,") ? String(raw.split(separator: ",", maxSplits: 1)[1]) : raw
    guard let data = Data(base64Encoded: base64, options: .ignoreUnknownCharacters),
          let decoded = NSImage(data: data) else {
        FileHandle.standardError.write("stdin 不是有效的 base64 圖片\n".data(using: .utf8)!)
        exit(2)
    }
    image = decoded
} else {
    guard let fromFile = NSImage(contentsOfFile: args[1]) else {
        FileHandle.standardError.write("讀不到圖片：\(args[1])\n".data(using: .utf8)!)
        exit(2)
    }
    image = fromFile
}

var rect = CGRect(origin: .zero, size: image!.size)
guard let cgImage = image!.cgImage(forProposedRect: &rect, context: nil, hints: nil) else {
    FileHandle.standardError.write("無法轉成 CGImage\n".data(using: .utf8)!)
    exit(3)
}

let request = VNDetectBarcodesRequest()
request.symbologies = [.qr]
let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])

do {
    try handler.perform([request])
    let payloads = (request.results ?? []).compactMap { $0.payloadStringValue }
    guard !payloads.isEmpty else {
        FileHandle.standardError.write("沒有解出任何 QR Code\n".data(using: .utf8)!)
        exit(1)
    }
    for payload in payloads { print(payload) }
} catch {
    FileHandle.standardError.write("解碼失敗：\(error)\n".data(using: .utf8)!)
    exit(4)
}
