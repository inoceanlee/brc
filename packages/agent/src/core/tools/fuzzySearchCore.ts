/**
 * Pure fuzzy-search core, kept free of app imports on purpose: it runs inside
 * the worker thread spawned by runFuzzySearchInWorker (fuzzySearch.ts), and
 * anything imported here is loaded per worker. Telemetry is returned as data
 * and captured on the main thread, which has the real client identity.
 */

/**
 * Computes the Levenshtein edit distance between two strings using dynamic
 * programming over two reusable rows, after trimming the common prefix and
 * suffix so the core stays free of third-party algorithm libraries.
 */
function levenshteinDistance(a: string, b: string): number {
    if (a.length > b.length) {
        const longer = a;
        a = b;
        b = longer;
    }

    const limit = a.length;
    let prefix = 0;
    while (prefix < limit && a[prefix] === b[prefix]) prefix++;

    let suffix = 0;
    while (suffix < limit - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;

    if (prefix + suffix >= a.length) return b.length - a.length;

    const shorterMiddle = a.length - prefix - suffix;
    const longerMiddle = b.length - prefix - suffix;
    const width = shorterMiddle + 1;
    const previous = new Uint32Array(width);
    const current = new Uint32Array(width);
    for (let index = 0; index < width; index++) previous[index] = index;

    for (let i = 1; i <= longerMiddle; i++) {
        current[0] = i;
        const target = b[prefix + i - 1];
        for (let j = 1; j < width; j++) {
            const cost = a[prefix + j - 1] === target ? 0 : 1;
            current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
        }
        previous.set(current);
    }

    return previous[width - 1];
}

export interface FuzzyMatch {
    start: number;
    end: number;
    value: string;
    distance: number;
}

export interface FuzzySearchMetrics {
    recursive: {
        execution_time_ms: number;
        text_length: number;
        query_length: number;
        result_distance: number;
    };
    iterative: {
        execution_time_ms: number;
        iterations: number;
        segment_length: number;
        query_length: number;
        final_distance: number;
    } | null;
}




let lastIterativeMetrics: FuzzySearchMetrics['iterative'] = null;

/**
 * Runs a full fuzzy search and returns the match together with the timing
 * metrics that used to be captured inline.
 */
export function runFuzzySearch(text: string, query: string): { result: FuzzyMatch; metrics: FuzzySearchMetrics } {
    const startTime = performance.now();
    lastIterativeMetrics = null;
    const result = recursiveFuzzyIndexOf(text, query);
    return {
        result,
        metrics: {
            recursive: {
                execution_time_ms: performance.now() - startTime,
                text_length: text.length,
                query_length: query.length,
                result_distance: result.distance
            },
            iterative: lastIterativeMetrics
        }
    };
}

/**
 * Recursively finds the closest match to a query string within text using fuzzy matching
 * @param text The text to search within
 * @param query The query string to find
 * @param start Start index in the text (default: 0)
 * @param end End index in the text (default: text.length)
 * @param parentDistance Best distance found so far (default: Infinity)
 * @returns Object with start and end indices, matched value, and Levenshtein distance
 */
export function recursiveFuzzyIndexOf(text: string, query: string, start: number = 0, end: number | null = null, parentDistance: number = Infinity): FuzzyMatch {
    if (end === null) end = text.length;


    if (end - start <= 2 * query.length) {
        return iterativeReduction(text, query, start, end, parentDistance);
    }

    let midPoint = start + Math.floor((end - start) / 2);
    let leftEnd = Math.min(end, midPoint + query.length); 
    let rightStart = Math.max(start, midPoint - query.length); 


    let leftDistance = levenshteinDistance(text.substring(start, leftEnd), query);
    let rightDistance = levenshteinDistance(text.substring(rightStart, end), query);
    let bestDistance = Math.min(leftDistance, parentDistance, rightDistance);


    if (parentDistance === bestDistance) {
        return iterativeReduction(text, query, start, end, parentDistance);
    }


    if (leftDistance < rightDistance) {
        return recursiveFuzzyIndexOf(text, query, start, leftEnd, bestDistance);
    } else {
        return recursiveFuzzyIndexOf(text, query, rightStart, end, bestDistance);
    }
}

/**
 * Iteratively refines the best match by reducing the search area
 * @param text The text to search within
 * @param query The query string to find
 * @param start Start index in the text
 * @param end End index in the text
 * @param parentDistance Best distance found so far
 * @returns Object with start and end indices, matched value, and Levenshtein distance
 */
function iterativeReduction(text: string, query: string, start: number, end: number, parentDistance: number): FuzzyMatch {
    const startTime = performance.now();
    let iterations = 0;





    let bestDistance = levenshteinDistance(text.substring(start, end), query);
    let bestStart = start;
    let bestEnd = end;


    let nextDistance = levenshteinDistance(text.substring(bestStart + 1, bestEnd), query);

    while (nextDistance < bestDistance) {
        bestDistance = nextDistance;
        bestStart++;
        const smallerString = text.substring(bestStart + 1, bestEnd);
        nextDistance = levenshteinDistance(smallerString, query);
        iterations++;
    }


    nextDistance = levenshteinDistance(text.substring(bestStart, bestEnd - 1), query);

    while (nextDistance < bestDistance) {
        bestDistance = nextDistance;
        bestEnd--;
        const smallerString = text.substring(bestStart, bestEnd - 1);
        nextDistance = levenshteinDistance(smallerString, query);
        iterations++;
    }

    lastIterativeMetrics = {
        execution_time_ms: performance.now() - startTime,
        iterations: iterations,
        segment_length: end - start,
        query_length: query.length,
        final_distance: bestDistance
    };

    return {
        start: bestStart,
        end: bestEnd,
        value: text.substring(bestStart, bestEnd),
        distance: bestDistance
    };
}

/**
 * Calculates the similarity ratio between two strings
 * @param a First string
 * @param b Second string
 * @returns Similarity ratio (0-1)
 */
export function getSimilarityRatio(a: string, b: string): number {
    const maxLength = Math.max(a.length, b.length);
    if (maxLength === 0) return 1; 

    const editDistance = levenshteinDistance(a, b);
    return 1 - (editDistance / maxLength);
}
