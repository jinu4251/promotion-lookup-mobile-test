/**
 * ScannerEngine - 웹 바코드 스캔 추상화 모듈
 * 
 * 특징:
 * 1. Html5-Qrcode + BarcodeDetector 하이브리드 엔진 적용
 *    (기기/브라우저가 BarcodeDetector 지원 시 하드웨어 가속, 미지원 시 소프트웨어 디코더 fallback)
 * 2. 잘못된 번호 인식(Ghost read) 방지: EAN-13 체크디지트 사전 필터링
 * 3. 동일 바코드 반복 인식 방지: 쿨다운(cooldownMs, 기본 1500ms) 디바운싱
 * 4. 문자열 타입 엄격 보존: 앞자리 0 누락 방지
 */

let EngineUtils = null;
if (typeof Utils !== 'undefined') {
  EngineUtils = Utils;
} else if (typeof require !== 'undefined') {
  EngineUtils = require('./utils.js').Utils;
}

class ScannerEngine {
  constructor(options = {}) {
    this.targetElementId = options.targetElementId || 'scanner-reader';
    this.fps = options.fps || 10;
    this.qrbox = options.qrbox || { width: 260, height: 160 };
    this.cooldownMs = options.cooldownMs || 1500;
    this.validateCheckDigit = options.validateCheckDigit !== false; // 기본 true
    this.onScanSuccess = options.onScanSuccess || (() => {});
    this.onScanError = options.onScanError || (() => {});
    
    this.html5QrCode = null;
    this.isScanning = false;
    this.lastScannedCode = null;
    this.lastScannedTimestamp = 0;
  }

  /**
   * 브라우저 환경 및 카메라, 네이티브 BarcodeDetector 지원 상태 진단
   */
  static async diagnoseEnvironment() {
    const report = {
      isHttps: (typeof location !== 'undefined') ? (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1') : false,
      hasMediaDevices: !!(typeof navigator !== 'undefined' && navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
      hasBarcodeDetector: (typeof window !== 'undefined' && 'BarcodeDetector' in window),
      supportedFormats: [],
      cameraCount: 0,
      cameras: []
    };

    if (report.hasBarcodeDetector) {
      try {
        report.supportedFormats = await window.BarcodeDetector.getSupportedFormats();
      } catch (e) {
        console.warn('BarcodeDetector 포맷 조회 실패:', e);
      }
    }

    if (report.hasMediaDevices) {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoInputs = devices.filter(d => d.kind === 'videoinput');
        report.cameraCount = videoInputs.length;
        report.cameras = videoInputs.map(v => ({ id: v.deviceId, label: v.label || 'Camera' }));
      } catch (e) {
        console.warn('카메라 장치 목록 조회 실패:', e);
      }
    }

    return report;
  }

  /**
   * 스캔 시작
   */
  async start() {
    if (this.isScanning) return;

    if (typeof Html5Qrcode === 'undefined') {
      throw new Error('Html5Qrcode 라이브러리가 로드되지 않았습니다.');
    }

    this.html5QrCode = new Html5Qrcode(this.targetElementId);

    const config = {
      fps: this.fps,
      qrbox: this.qrbox,
      aspectRatio: 1.0,
      experimentalFeatures: {
        useBarCodeDetectorIfSupported: true // BarcodeDetector 하이브리드 엔진 활성화
      }
    };

    try {
      await this.html5QrCode.start(
        { facingMode: 'environment' }, // 후면 카메라 기본
        config,
        (decodedText, decodedResult) => {
          this.handleDecodedText(decodedText, decodedResult);
        },
        (errorMessage) => {
          this.onScanError(errorMessage);
        }
      );
      this.isScanning = true;
    } catch (err) {
      this.isScanning = false;
      throw new Error(`카메라 시작 실패: ${err.message || err}`);
    }
  }

  /**
   * 디코딩 결과 필터링 및 디바운스
   */
  handleDecodedText(rawText, decodedResult) {
    if (!rawText) return;
    const cleanCode = String(rawText).trim();
    const now = Date.now();

    // 1. 동일 바코드 반복 인식 방지 (Cooldown 디바운스)
    if (cleanCode === this.lastScannedCode && (now - this.lastScannedTimestamp < this.cooldownMs)) {
      return;
    }

    // 2. 잘못된 번호 인식 방지: EAN-13 체크디지트 검사 (13자리인 경우)
    if (this.validateCheckDigit && cleanCode.length === 13 && EngineUtils?.validateEAN13) {
      const checkRes = EngineUtils.validateEAN13(cleanCode);
      if (!checkRes.valid) {
        console.warn(`[ScannerEngine] 잘못된 체크디지트 감지(Ghost read 차단): ${cleanCode}`, checkRes.error);
        return;
      }
    }

    this.lastScannedCode = cleanCode;
    this.lastScannedTimestamp = now;

    // 성공 콜백 호출
    this.onScanSuccess(cleanCode, decodedResult);
  }

  /**
   * 스캔 중지
   */
  async stop() {
    if (!this.isScanning || !this.html5QrCode) return;
    try {
      await this.html5QrCode.stop();
      this.html5QrCode.clear();
    } catch (e) {
      console.warn('[ScannerEngine] 스캐너 중지 알림:', e);
    } finally {
      this.isScanning = false;
    }
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ScannerEngine };
}
