/*!
 * @license Adapted from simple-statistics 0.7.0.
 * Copyright (c) 2012 Tom MacWright
 * All rights reserved.
 * 
 * Redistribution and use in source and binary forms, with or without modification,
 * are permitted provided that the following conditions are met:
 * 
 * - Redistributions of source code must retain the above copyright notice, this
 *   list of conditions and the following disclaimer.
 * - Redistributions in binary form must reproduce the above copyright notice, this
 *   list of conditions and the following disclaimer in the documentation and/or
 *   other materials provided with the distribution.
 * - Neither the name "simple-statistics" nor the names of its contributors may be
 *   used to endorse or promote products derived from this software without
 *   specific prior written permission.
 * 
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR
 * ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
 * (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
 * LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON
 * ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
 * SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

'use strict';

function mean(values) {
  if (!values.length) return null;
  let total = 0;
  for (let i = 0; i < values.length; i++) total += values[i];
  return total / values.length;
}

function standard_deviation(values) {
  if (!values.length) return null;
  const average = mean(values);
  let squares = 0;
  // Retain the old summation order and population denominator, without a
  // temporary array of squared deviations.
  for (let i = 0; i < values.length; i++) squares += Math.pow(values[i] - average, 2);
  return Math.sqrt(squares / values.length);
}

function quantile(values, probabilities) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  function at(p) {
    const index = sorted.length * p;
    if (p < 0 || p > 1) return null;
    if (p === 0) return sorted[0];
    if (p === 1) return sorted[sorted.length - 1];
    if (index % 1 !== 0) return sorted[Math.ceil(index) - 1];
    if (sorted.length % 2 === 0) return (sorted[index - 1] + sorted[index]) / 2;
    return sorted[index];
  }
  // Preserve the legacy scalar/array contract, including an empty probability
  // array being treated as a scalar. Report callers use nonempty arrays.
  if (probabilities.length) return Array.from(probabilities, at);
  return at(probabilities);
}

module.exports = {mean, standard_deviation, quantile};
