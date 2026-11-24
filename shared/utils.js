/**
 * 공통 유틸리티 (Utils)
 */
const Utils = {
  /**
   * EAN-13 체크디지트 검증
   * @param {string} barcode 
   * @returns {{ valid: boolean, calculatedCheckDigit?: number, error?: string }}
   */
  validateEAN13(barcode) {
    if (typeof barcode !== 'string') {
      return { valid: false, error: '바코드는 문자열이어야 합니다.' };
    }

    const clean = barcode.trim();
    if (!/^\d{13}$/.test(clean)) {
      return { valid: false, error: 'EAN-13 바코드는 13자리 숫자여야 합니다.' };
    }

    let oddSum = 0;
    let evenSum = 0;

    // 0-indexed: 0, 2, 4, 6, 8, 10은 1,3,5,7,9,11번째 (가중치 1)
    //            1, 3, 5, 7, 9, 11은 2,4,6,8,10,12번째 (가중치 3)
    for (let i = 0; i < 12; i++) {
      const digit = parseInt(clean.charAt(i), 10);
      if (i % 2 === 0) {
        oddSum += digit;
      } else {
        evenSum += digit;
      }
    }

    const totalSum = oddSum + (evenSum * 3);
    const remainder = totalSum % 10;
    const calculated = (10 - remainder) % 10;
    const givenCheckDigit = parseInt(clean.charAt(12), 10);

    const isValid = calculated === givenCheckDigit;
    return {
      valid: isValid,
      calculatedCheckDigit: calculated,
      givenCheckDigit: givenCheckDigit,
      error: isValid ? null : `체크디지트 불일치 (계산값: ${calculated}, 입력값: ${givenCheckDigit})`
    };
  },

  /**
   * EAN-8 체크디지트 검증 (표준 Modulo-10 가중치 3, 1 반복)
   * @param {string} barcode 
   * @returns {{ valid: boolean, calculatedCheckDigit?: number, givenCheckDigit?: number, error?: string }}
   */
  validateEAN8(barcode) {
    if (typeof barcode !== 'string') {
      return { valid: false, error: '바코드는 문자열이어야 합니다.' };
    }

    const clean = barcode.trim();
    if (!/^\d{8}$/.test(clean)) {
      return { valid: false, error: 'EAN-8 바코드는 8자리 숫자여야 합니다.' };
    }

    let sum = 0;
    // 0-indexed: 0, 2, 4, 6번째는 가중치 3
    //            1, 3, 5번째는 가중치 1
    for (let i = 0; i < 7; i++) {
      const digit = parseInt(clean.charAt(i), 10);
      sum += (i % 2 === 0) ? digit * 3 : digit;
    }

    const remainder = sum % 10;
    const calculated = (10 - remainder) % 10;
    const givenCheckDigit = parseInt(clean.charAt(7), 10);

    const isValid = calculated === givenCheckDigit;
    return {
      valid: isValid,
      calculatedCheckDigit: calculated,
      givenCheckDigit: givenCheckDigit,
      error: isValid ? null : `체크디지트 불일치 (계산값: ${calculated}, 입력값: ${givenCheckDigit})`
    };
  },

  /**
   * 통화 원화 포맷
   */
  formatCurrency(value) {
    if (value === null || value === undefined || value === '' || isNaN(value)) return '-';
    return Number(value).toLocaleString('ko-KR') + '원';
  },

  /**
   * 날짜 포맷 (원본 연도 미표기 시 원문 보존)
   */
  formatDate(dateStr) {
    if (!dateStr) return '-';
    const s = String(dateStr).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      return s.replace(/-/g, '.');
    }
    return s;
  },

  /**
   * 할인율 계산 (소수점 1자리 지원, 단 원본에 할인율 문자열이 있으면 원본 우선)
   */
  calculateDiscountRate(normalPrice, discountPrice) {
    if (!normalPrice || !discountPrice || normalPrice <= discountPrice) return 0;
    return Math.round(((normalPrice - discountPrice) / normalPrice) * 1000) / 10;
  },

  /**
   * 프로모션 유형별 CSS 뱃지 클래스
   */
  getBadgeClass(promotionType) {
    switch (promotionType) {
      case '1+1':
        return 'badge-one-plus-one';
      case '2+1':
      case '다다익선':
        return 'badge-two-plus-one';
      case '가격할인':
        return 'badge-discount';
      case '증정':
      case '상품권증정(공통조건)':
        return 'badge-gift';
      default:
        return 'badge-default';
    }
  },

  /**
   * HTML 특수문자 안전 이스케이프 (XSS 방지)
   * @param {*} val 
   * @returns {string}
   */
  escapeHtml(val) {
    if (val === null || val === undefined) return '';
    const str = String(val);
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  },

  /**
   * JWT 페이로드 안전 디코딩 (클라이언트 표출용, 서명 검증은 서버에서 수행)
   * @param {string} token 
   * @returns {Object|null}
   */
  parseJwtPayload(token) {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length < 2) return null;
    try {
      const base64Url = parts[1];
      const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
      const padLen = (4 - (base64.length % 4)) % 4;
      const padded = base64 + '='.repeat(padLen);
      const jsonPayload = decodeURIComponent(
        atob(padded)
          .split('')
          .map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
          .join('')
      );
      return JSON.parse(jsonPayload);
    } catch (e) {
      return null;
    }
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { Utils };
}
