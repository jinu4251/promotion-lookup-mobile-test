/**
 * DataMatcher - 바코드 검증 및 상품 마스터 데이터 정확 매칭 모듈
 * 
 * 원칙:
 * 1. 바코드는 반드시 '문자열(String)'로 유지하여 앞자리 0을 보존한다.
 * 2. 체크디지트 검증을 통과한 유효한 EAN-13 바코드만 우선 검색한다.
 * 3. 정확 일치(Exact Match)만 허용하며, 부분 일치(Substring/Prefix)는 철저히 차단한다.
 * 4. 상품별 원본 데이터(baseProduct), 조건부 프로모션(conditionalPromotions: 가격할인, 다다익선 등),
 *    공통 증정조건(commonGiftConditions: 상품권 증정조건)을 각각 구분하여 보존한다.
 * 5. 프로모션들이 분리 수집되었다는 이유로 모든 할인이 중복 적용되는 것으로 해석하지 않으며(allDiscountsStackableAssumed: false),
 *    할인단가 임의 계산 및 상품권 합산 충족 여부 자동 판정을 금지한다.
 * 6. 원본에 행사 연도가 명시되지 않은 경우('11월 12일' 등) 임의로 2026년을 적용하지 않으며,
 *    yearConfirmed: false인 경우 진행 중·예정·종료를 확정하지 않고 '행사 연도 확인 필요'(YEAR_UNCONFIRMED) 상태로 처리한다.
 * 7. 이미지 전사 자료는 원본 엑셀 최종 대조 전까지 운영용 확정 마스터로 취급하지 않는다(excelSourceVerified: false).
 */

let LocalUtils = null;
if (typeof Utils !== 'undefined') {
  LocalUtils = Utils;
} else if (typeof require !== 'undefined') {
  LocalUtils = require('./utils.js').Utils;
}

class DataMatcher {
  constructor(products = []) {
    this.productMap = new Map();
    this.rawProductMap = new Map();
    this.setProducts(products);
  }

  /**
   * 엑셀/CSV 한글 열 이름 또는 영문 필드명을 표준 내부 스키마로 1:1 정규화 (원문 표기 100% 보존)
   */
  static normalizeRawRow(raw = {}) {
    if (!raw || typeof raw !== 'object') return {};

    const pick = (...keys) => {
      for (const k of keys) {
        if (raw[k] !== undefined && raw[k] !== null) return raw[k];
      }
      return undefined;
    };

    const barcodeVal = pick('barcode', '판매코드_바코드', '판매코드', '바코드');
    const productNameVal = pick('productName', '상품명_원문', '상품명');
    const specVal = pick('spec', '단위_규격', '규격');
    const categoryVal = pick('category', '카테고리');
    const verificationGroupVal = pick('verificationGroup', '검증그룹');
    const leafletMarkVal = pick('leafletMark', '전단여부');

    const startDateVal = pick('startDate', '행사시작일_원문', '행사시작일');
    const endDateVal = pick('endDate', '행사종료일_원문', '행사종료일');
    const eventYearVal = pick('confirmedYear', 'eventYear', '행사연도');
    const yearConfirmedRaw = pick('yearConfirmed', '연도확정');

    let yearConfirmedFlag = null;
    if (yearConfirmedRaw === true || String(yearConfirmedRaw).toLowerCase() === 'true') {
      yearConfirmedFlag = true;
    } else if (yearConfirmedRaw === false || String(yearConfirmedRaw).toLowerCase() === 'false') {
      yearConfirmedFlag = false;
    }

    const normalPriceRaw = pick('normalPrice', '정상가_원', '정상가');
    const discountPriceRaw = pick('discountPrice', '행사가_원', '행사가');
    const discountAmountRaw = pick('discountAmount', '할인액_원', '할인액');
    const discountRateRaw = pick('discountRate', '할인율_퍼센트', '할인율');
    const unitPriceRaw = pick('unitPrice', '단위당가격_원', '단위당가격');

    const promotionTypeVal = pick('promotionType', '행사유형');
    const promotionDetailVal = pick('promotionDetail', 'Promotion_세부정보_원문', 'Promotion 세부 정보');
    const giftConditionVal = pick('giftConditionNote', 'remark', '비고_공통증정조건_원문', '비고');

    let discountRateStr = '';
    let discountRateNum = null;
    if (discountRateRaw !== undefined && discountRateRaw !== null && String(discountRateRaw).trim() !== '') {
      const s = String(discountRateRaw).trim();
      discountRateNum = parseFloat(s.replace('%', ''));
      discountRateStr = s.endsWith('%') ? s : `${s}%`;
    }

    return {
      ...raw,
      verificationGroup: verificationGroupVal !== undefined ? String(verificationGroupVal).trim() : '',
      barcode: barcodeVal !== undefined ? String(barcodeVal).trim() : '',
      productName: productNameVal !== undefined ? String(productNameVal).trim() : '',
      spec: specVal !== undefined ? String(specVal).trim() : '',
      category: categoryVal !== undefined ? String(categoryVal).trim() : '',
      leafletMark: leafletMarkVal !== undefined ? String(leafletMarkVal).trim() : '',
      startDate: startDateVal !== undefined ? String(startDateVal).trim() : '',
      endDate: endDateVal !== undefined ? String(endDateVal).trim() : '',
      eventYear: (eventYearVal !== undefined && String(eventYearVal).trim() !== '') ? String(eventYearVal).trim() : null,
      yearConfirmedExplicit: yearConfirmedFlag,
      normalPrice: (normalPriceRaw !== undefined && String(normalPriceRaw).trim() !== '') ? Number(String(normalPriceRaw).replace(/,/g, '')) : null,
      discountPrice: (discountPriceRaw !== undefined && String(discountPriceRaw).trim() !== '') ? Number(String(discountPriceRaw).replace(/,/g, '')) : null,
      discountAmount: (discountAmountRaw !== undefined && String(discountAmountRaw).trim() !== '') ? Number(String(discountAmountRaw).replace(/,/g, '')) : null,
      discountRate: discountRateStr,
      discountRateValue: isNaN(discountRateNum) ? null : discountRateNum,
      unitPrice: (unitPriceRaw !== undefined && String(unitPriceRaw).trim() !== '') ? Number(String(unitPriceRaw).replace(/,/g, '')) : null,
      promotionType: promotionTypeVal !== undefined ? String(promotionTypeVal).trim() : '',
      promotionDetail: promotionDetailVal !== undefined ? String(promotionDetailVal).trim() : '',
      giftConditionNote: giftConditionVal !== undefined ? String(giftConditionVal).trim() : '',
      excelSourceVerified: raw.excelSourceVerified === true
    };
  }

  /**
   * 원본 날짜 문자열 파싱
   * @param {string} rawDate
   * @param {number|string|null} [confirmedYear=null] 관리자가 확인·승인한 적용 연도
   */
  static parseDateInfo(rawDate, confirmedYear = null) {
    if (!rawDate) {
      return { raw: '', yearConfirmed: false, monthDay: null, fullIso: null };
    }
    const str = String(rawDate).trim();

    // 1. YYYY-MM-DD 또는 YYYY.MM.DD 형식 (원본에 연도가 명시된 경우)
    const fullMatch = str.match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})$/);
    if (fullMatch) {
      const y = fullMatch[1];
      const m = fullMatch[2].padStart(2, '0');
      const d = fullMatch[3].padStart(2, '0');
      return {
        raw: str,
        yearConfirmed: true,
        year: Number(y),
        monthDay: `${m}-${d}`,
        fullIso: `${y}-${m}-${d}`
      };
    }

    // 2. '11월 12일', '11-12', '11/12', '11.12' 등 연도가 명시되지 않은 형식
    const krMatch = str.match(/^(\d{1,2})\s*월\s*(\d{1,2})\s*일?$/) || str.match(/^(\d{1,2})[-./](\d{1,2})$/);
    if (krMatch) {
      const m = krMatch[1].padStart(2, '0');
      const d = krMatch[2].padStart(2, '0');

      // 관리자가 명시적으로 연도를 확인·승인한 경우에만 fullIso 생성
      if (confirmedYear && /^\d{4}$/.test(String(confirmedYear).trim())) {
        const y = String(confirmedYear).trim();
        return {
          raw: str,
          yearConfirmed: true,
          year: Number(y),
          monthDay: `${m}-${d}`,
          fullIso: `${y}-${m}-${d}`
        };
      }

      // 연도 미확정 시 임의로 2026년을 적용하지 않음
      return {
        raw: str,
        yearConfirmed: false,
        year: null,
        monthDay: `${m}-${d}`,
        fullIso: null
      };
    }

    return { raw: str, yearConfirmed: false, monthDay: null, fullIso: null };
  }

  /**
   * 행사 기간 상태 판별
   * - yearConfirmed === false 이면 진행 중·예정·종료를 확정하지 않고 'YEAR_UNCONFIRMED'('행사 연도 확인 필요') 반환
   */
  static evaluatePeriodStatus(startDateRaw, endDateRaw, itemStatus, currentDate = new Date(), confirmedYear = null) {
    const startInfo = DataMatcher.parseDateInfo(startDateRaw, confirmedYear);
    const endInfo = DataMatcher.parseDateInfo(endDateRaw, confirmedYear);
    const yearConfirmed = startInfo.yearConfirmed && endInfo.yearConfirmed;

    if (itemStatus === 'EXPIRED') {
      return {
        computedStatus: 'EXPIRED',
        statusMessage: '행사가 종료된 상품입니다.',
        yearConfirmed,
        rawStartDate: startInfo.raw,
        rawEndDate: endInfo.raw,
        resolvedStartDate: startInfo.fullIso,
        resolvedEndDate: endInfo.fullIso
      };
    }

    // 원본에 행사 연도가 없고 관리자 연도 승인도 없는 경우: 임의로 연도를 가정하여 상태를 확정하지 않음
    if (!yearConfirmed || !startInfo.fullIso || !endInfo.fullIso) {
      return {
        computedStatus: 'YEAR_UNCONFIRMED',
        statusMessage: '행사 연도 확인 필요',
        yearConfirmed: false,
        rawStartDate: startInfo.raw,
        rawEndDate: endInfo.raw,
        resolvedStartDate: null,
        resolvedEndDate: null
      };
    }

    const nowIso = currentDate.toISOString().slice(0, 10);
    if (nowIso > endInfo.fullIso) {
      return {
        computedStatus: 'EXPIRED',
        statusMessage: '행사가 종료된 상품입니다.',
        yearConfirmed: true,
        rawStartDate: startInfo.raw,
        rawEndDate: endInfo.raw,
        resolvedStartDate: startInfo.fullIso,
        resolvedEndDate: endInfo.fullIso
      };
    }
    if (nowIso < startInfo.fullIso) {
      return {
        computedStatus: 'UPCOMING',
        statusMessage: '진행 예정인 행사입니다.',
        yearConfirmed: true,
        rawStartDate: startInfo.raw,
        rawEndDate: endInfo.raw,
        resolvedStartDate: startInfo.fullIso,
        resolvedEndDate: endInfo.fullIso
      };
    }

    return {
      computedStatus: 'ACTIVE',
      statusMessage: '진행 중인 행사',
      yearConfirmed: true,
      rawStartDate: startInfo.raw,
      rawEndDate: endInfo.raw,
      resolvedStartDate: startInfo.fullIso,
      resolvedEndDate: endInfo.fullIso
    };
  }

  /**
   * 마스터 목록 전체가 게시 가능한지(모든 항목의 연도 및 원본 검증 여부) 검사
   */
  static validateMasterForPublish(products = [], confirmedYear = null) {
    const errors = [];
    if (!Array.isArray(products) || products.length === 0) {
      return { valid: false, code: 'EMPTY_MASTER', errors: ['게시할 상품 데이터가 없습니다.'] };
    }

    products.forEach((rawItem, idx) => {
      const item = DataMatcher.normalizeRawRow(rawItem);
      const code = item.barcode;
      const name = item.productName;
      if (!code || !/^\d{8,14}$/.test(code)) {
        errors.push(`행 ${idx + 1}: 유효하지 않은 바코드 (${code || '누락'})`);
      } else if (code.length === 13 && LocalUtils?.validateEAN13) {
        const check = LocalUtils.validateEAN13(code);
        if (!check.valid) {
          errors.push(`행 ${idx + 1}: EAN-13 체크디지트 오류 (${code})`);
        }
      }
      if (!name) {
        errors.push(`행 ${idx + 1} (${code}): 상품명 누락`);
      }

      const itemYear = item.eventYear || confirmedYear || null;
      const sInfo = DataMatcher.parseDateInfo(item.startDate, itemYear);
      const eInfo = DataMatcher.parseDateInfo(item.endDate, itemYear);
      if (!sInfo.yearConfirmed || !eInfo.yearConfirmed) {
        errors.push(`행 ${idx + 1} (${code}): 행사 연도 미확정 (${sInfo.raw} ~ ${eInfo.raw}) — 관리자 연도 확인 및 승인 필요`);
      } else if (sInfo.fullIso > eInfo.fullIso) {
        errors.push(`행 ${idx + 1} (${code}): 행사 시작일(${sInfo.fullIso})이 종료일(${eInfo.fullIso})보다 늦음`);
      }
    });

    const hasYearError = errors.some(e => e.includes('행사 연도 미확정'));
    return {
      valid: errors.length === 0,
      code: errors.length === 0 ? 'OK' : (hasYearError ? 'YEAR_CONFIRMATION_REQUIRED' : 'VALIDATION_FAILED'),
      errors
    };
  }

  /**
   * 단일 행에서 조건부 프로모션(가격할인, 다다익선 등)과 공통 증정조건(비고 상품권 증정)을 구분 추출
   */
  static decomposeRowPromotions(rawItem) {
    const item = DataMatcher.normalizeRawRow(rawItem);
    const entries = [];
    const normalPrice = item.normalPrice;
    const discountPrice = item.discountPrice;
    const hasPriceDiscount = (normalPrice !== null && discountPrice !== null && normalPrice > discountPrice && discountPrice > 0);

    const discountAmount = (item.discountAmount !== null && item.discountAmount !== undefined)
      ? item.discountAmount
      : (hasPriceDiscount ? (normalPrice - discountPrice) : 0);

    const discountRate = item.discountRate
      ? item.discountRate
      : (hasPriceDiscount && LocalUtils?.calculateDiscountRate ? `${LocalUtils.calculateDiscountRate(normalPrice, discountPrice)}%` : '');

    const rawType = item.promotionType;
    const rawDetail = item.promotionDetail;
    const giftConditionNote = item.giftConditionNote;

    // 1. 가격정보(정상가 > 행사가)와 다다익선 등 타 행사유형이 한 행에 병행 존재하는 경우 (C그룹 케이스)
    if (hasPriceDiscount && rawType && rawType !== '가격할인' && rawDetail) {
      const priceDetailText = `정상가 ${normalPrice.toLocaleString('ko-KR')}원 → 행사가 ${discountPrice.toLocaleString('ko-KR')}원 (할인액 ${discountAmount.toLocaleString('ko-KR')}원${discountRate ? `, 할인율 ${discountRate}` : ''})`;
      entries.push({
        ...item,
        promotionCategory: 'CONDITIONAL_PROMOTION',
        promotionScope: 'INDIVIDUAL_PRICE_DISCOUNT',
        promotionType: '가격할인',
        normalPrice,
        discountPrice,
        discountAmount,
        discountRate,
        promotionDetail: priceDetailText,
        originalDetail: priceDetailText,
        arbitraryCalculationProhibited: true,
        duplicateDiscountAssumed: false
      });

      entries.push({
        ...item,
        promotionCategory: 'CONDITIONAL_PROMOTION',
        promotionScope: 'INDIVIDUAL_PROMOTION_DETAIL',
        promotionType: rawType,
        normalPrice,
        discountPrice,
        discountAmount: 0,
        discountRate: '',
        promotionDetail: rawDetail,
        originalDetail: rawDetail,
        arbitraryCalculationProhibited: true,
        duplicateDiscountAssumed: false
      });
    } else {
      // 2. 가격할인 단독(A그룹) 또는 다다익선 단독(B그룹) 또는 일반 1+1/2+1
      let detailToUse = rawDetail;
      if (!detailToUse && rawType === '가격할인' && hasPriceDiscount) {
        detailToUse = `정상가 ${normalPrice.toLocaleString('ko-KR')}원 → 행사가 ${discountPrice.toLocaleString('ko-KR')}원 (할인액 ${discountAmount.toLocaleString('ko-KR')}원${discountRate ? `, 할인율 ${discountRate}` : ''})`;
      }

      if (rawType || detailToUse || hasPriceDiscount) {
        entries.push({
          ...item,
          promotionCategory: 'CONDITIONAL_PROMOTION',
          promotionScope: rawType === '가격할인' ? 'INDIVIDUAL_PRICE_DISCOUNT' : 'INDIVIDUAL_PROMOTION_DETAIL',
          promotionType: rawType || (hasPriceDiscount ? '가격할인' : '기타'),
          normalPrice,
          discountPrice,
          discountAmount: (rawType === '가격할인' || hasPriceDiscount) ? discountAmount : 0,
          discountRate: (rawType === '가격할인' || hasPriceDiscount) ? discountRate : '',
          promotionDetail: detailToUse,
          originalDetail: detailToUse,
          arbitraryCalculationProhibited: true,
          duplicateDiscountAssumed: false
        });
      }
    }

    // 3. 비고 열의 공통 상품권 증정조건 분리 보존
    if (giftConditionNote) {
      entries.push({
        barcode: item.barcode,
        productName: item.productName,
        spec: item.spec || '',
        category: item.category || '',
        leafletMark: item.leafletMark || '',
        normalPrice,
        discountPrice,
        unitPrice: item.unitPrice,
        discountAmount: 0,
        discountRate: '',
        promotionCategory: 'COMMON_GIFT_CONDITION',
        promotionScope: 'COMMON_GIFT_CONDITION',
        promotionType: '상품권증정(공통조건)',
        promotionDetail: giftConditionNote,
        originalDetail: giftConditionNote,
        giftConditionNote: giftConditionNote,
        startDate: item.startDate,
        endDate: item.endDate,
        confirmedYear: item.eventYear || null,
        targetAudience: item.targetAudience || '행사조건충족고객',
        status: item.status || 'ACTIVE',
        autoEligibilityCalculated: false,
        duplicateDiscountAssumed: false
      });
    }

    return entries;
  }

  /**
   * 상품 마스터 데이터 로드 및 인덱싱
   * @param {Array} products 
   */
  setProducts(products) {
    this.productMap.clear();
    this.rawProductMap.clear();
    if (!Array.isArray(products)) return;

    for (const rawItem of products) {
      if (!rawItem) continue;
      const item = DataMatcher.normalizeRawRow(rawItem);
      const rawCode = item.barcode;
      if (!rawCode) continue;

      if (!this.rawProductMap.has(rawCode)) {
        this.rawProductMap.set(rawCode, Object.freeze({ ...item }));
      }
      if (!this.productMap.has(rawCode)) {
        this.productMap.set(rawCode, []);
      }

      const decomposed = DataMatcher.decomposeRowPromotions(item);
      const list = this.productMap.get(rawCode);
      for (const entry of decomposed) {
        const isDuplicateCommon = entry.promotionScope === 'COMMON_GIFT_CONDITION' &&
          list.some(existing => existing.promotionScope === 'COMMON_GIFT_CONDITION' && existing.originalDetail === entry.originalDetail);
        if (!isDuplicateCommon) {
          list.push(Object.freeze(entry));
        }
      }
    }
  }

  /**
   * 바코드 조회 파이프라인
   * @param {string} rawBarcode 
   * @param {Date} [currentDate=new Date()]
   * @param {boolean} [requireValidCheckDigit=true]
   * @param {number|string|null} [confirmedYearOverride=null] 관리자가 승인한 적용 연도
   * @returns {Object} 조회 결과
   */
  lookup(rawBarcode, currentDate = new Date(), requireValidCheckDigit = true, confirmedYearOverride = null) {
    const startTime = (typeof performance !== 'undefined' && performance.now) 
      ? performance.now() 
      : Date.now();

    if (rawBarcode === undefined || rawBarcode === null || String(rawBarcode).trim() === '') {
      return {
        found: false,
        barcode: '',
        reason: 'EMPTY_BARCODE',
        message: '바코드가 입력되지 않았습니다.',
        elapsedMs: 0
      };
    }

    const barcodeStr = String(rawBarcode).trim();

    if (!/^\d+$/.test(barcodeStr)) {
      const elapsedMs = ((typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()) - startTime);
      return {
        found: false,
        barcode: barcodeStr,
        reason: 'INVALID_FORMAT',
        message: '바코드에 숫자가 아닌 문자가 포함되어 있습니다.',
        elapsedMs
      };
    }

    let checkDigitInfo = { valid: true };
    if (barcodeStr.length === 13 && LocalUtils?.validateEAN13) {
      checkDigitInfo = LocalUtils.validateEAN13(barcodeStr);
      if (!checkDigitInfo.valid && requireValidCheckDigit) {
        const elapsedMs = ((typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()) - startTime);
        return {
          found: false,
          barcode: barcodeStr,
          reason: 'CHECK_DIGIT_FAIL',
          message: `유효하지 않은 바코드입니다: ${checkDigitInfo.error}`,
          checkDigitInfo,
          elapsedMs
        };
      }
    } else if (barcodeStr.length !== 13 && requireValidCheckDigit) {
      const elapsedMs = ((typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()) - startTime);
      return {
        found: false,
        barcode: barcodeStr,
        reason: 'INVALID_LENGTH',
        message: `바코드 자릿수가 올바르지 않습니다 (입력: ${barcodeStr.length}자리, 요구: 13자리)`,
        elapsedMs
      };
    }

    const matchedItems = this.productMap.get(barcodeStr);
    const rawBaseItem = this.rawProductMap.get(barcodeStr);

    if (!matchedItems || matchedItems.length === 0) {
      const elapsedMs = ((typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()) - startTime);
      return {
        found: false,
        barcode: barcodeStr,
        reason: 'NOT_FOUND',
        message: '등록되지 않은 행사상품입니다.',
        checkDigitInfo,
        elapsedMs
      };
    }

    const primaryItem = rawBaseItem || matchedItems[0];

    const evaluatedPromotions = matchedItems.map((item) => {
      const effectiveConfirmedYear = confirmedYearOverride || item.confirmedYear || item.eventYear || null;
      const periodEval = DataMatcher.evaluatePeriodStatus(
        item.startDate,
        item.endDate,
        item.status,
        currentDate,
        effectiveConfirmedYear
      );

      return {
        ...item,
        computedStatus: periodEval.computedStatus,
        statusMessage: periodEval.statusMessage,
        yearConfirmed: periodEval.yearConfirmed,
        rawStartDate: periodEval.rawStartDate,
        rawEndDate: periodEval.rawEndDate,
        resolvedStartDate: periodEval.resolvedStartDate,
        resolvedEndDate: periodEval.resolvedEndDate,
        originalDetail: item.originalDetail || item.promotionDetail
      };
    });

    const conditionalPromotions = evaluatedPromotions.filter(p => p.promotionScope !== 'COMMON_GIFT_CONDITION');
    const commonGiftConditions = evaluatedPromotions.filter(p => p.promotionScope === 'COMMON_GIFT_CONDITION');

    const hasActive = evaluatedPromotions.some(p => p.computedStatus === 'ACTIVE');
    const primaryPromotion = evaluatedPromotions.find(p => p.computedStatus === 'ACTIVE') || evaluatedPromotions[0];

    const baseProduct = {
      verificationGroup: primaryItem.verificationGroup || '',
      barcode: barcodeStr,
      productName: primaryItem.productName,
      spec: primaryItem.spec || '',
      category: primaryItem.category || '',
      leafletMark: primaryItem.leafletMark || '',
      normalPrice: primaryItem.normalPrice,
      discountPrice: primaryItem.discountPrice,
      discountAmount: primaryItem.discountAmount !== null && primaryItem.discountAmount !== undefined
        ? primaryItem.discountAmount
        : ((primaryItem.normalPrice > primaryItem.discountPrice && primaryItem.discountPrice > 0) ? (primaryItem.normalPrice - primaryItem.discountPrice) : 0),
      discountRate: primaryItem.discountRate || '',
      discountRateValue: primaryItem.discountRateValue ?? null,
      unitPrice: primaryItem.unitPrice ?? null,
      rawStartDate: evaluatedPromotions[0]?.rawStartDate || primaryItem.startDate || '',
      rawEndDate: evaluatedPromotions[0]?.rawEndDate || primaryItem.endDate || '',
      yearConfirmed: evaluatedPromotions[0]?.yearConfirmed ?? false,
      excelSourceVerified: primaryItem.excelSourceVerified === true,
      unconfirmedFields: Array.isArray(primaryItem.unconfirmedFields) ? primaryItem.unconfirmedFields : []
    };

    const elapsedMs = ((typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()) - startTime);

    return {
      found: true,
      barcode: barcodeStr,
      verificationGroup: baseProduct.verificationGroup,
      productName: baseProduct.productName,
      spec: baseProduct.spec,
      category: baseProduct.category,
      leafletMark: baseProduct.leafletMark,
      normalPrice: baseProduct.normalPrice,
      discountPrice: baseProduct.discountPrice,
      discountAmount: baseProduct.discountAmount,
      discountRate: baseProduct.discountRate,
      unitPrice: baseProduct.unitPrice,
      yearConfirmed: baseProduct.yearConfirmed,
      excelSourceVerified: baseProduct.excelSourceVerified,
      baseProduct,
      conditionalPromotions,
      commonGiftConditions,
      allDiscountsStackableAssumed: false,
      autoEligibilityCalculated: false,
      hasMultiplePromotions: evaluatedPromotions.length > 1,
      promotionCount: evaluatedPromotions.length,
      promotions: evaluatedPromotions,
      primaryPromotion,
      hasActivePromotion: hasActive,
      checkDigitInfo,
      elapsedMs
    };
  }

  getUniqueBarcodeCount() {
    return this.productMap.size;
  }

  getTotalPromotionCount() {
    let total = 0;
    for (const list of this.productMap.values()) {
      total += list.length;
    }
    return total;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { DataMatcher };
}
