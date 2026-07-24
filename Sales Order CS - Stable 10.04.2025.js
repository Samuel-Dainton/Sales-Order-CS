/**
 * @NApiVersion 2.0
 * @NScriptType ClientScript
 */
define([
    'N/log', 'N/runtime', 'N/ui/dialog', 'N/search', 'SuiteScripts/FHL/Library.FHL.2.0.js', 'SuiteScripts/FHL/Custom Emails/Library.CustomEmails.js'
], function (log, runtime, dialog, search, Library, LibraryCustomEmails) {
    'use strict';

    var mode = null;
    var creditViolation = false;
    var originalOrderAmount = null; // subtotal as loaded from the DB, captured at pageInit in edit mode (acts as our "oldRecord" value)
    var originalShippingCost = null; // shippingcost as loaded from the DB, captured at pageInit in edit mode (acts as our "oldRecord" value)

    // fieldChanged - unified
    function fieldChanged(context) {
        var currentRecord = context.currentRecord;
        var fieldId = context.fieldId;
        var sublistId = context.sublistId;
        // NOTE: fieldChanged's context does not include `mode` — rely on the
        // module-level `mode` variable set in pageInit instead.

        // Short-circuit webstore when appropriate for certain logic (but some webstore logic still runs)
        if (runtime.executionContext === runtime.ContextType.WEBSTORE) {
            // from Sales Order script: handle custbody_tt_extra_delivery_charges
            if (fieldId === 'custbody_tt_extra_delivery_charges') {
                try {
                    var newShippingCost = currentRecord.getValue({ fieldId: 'custbody_tt_extra_delivery_charges' });
                    currentRecord.setValue({
                        fieldId: 'shippingcost',
                        value: parseFloat(newShippingCost),
                        ignoreFieldChange: false
                    });
                    currentRecord.setValue({ fieldId: 'custbody_for_courier', value: true });
                } catch (e) {
                    log.error('Error setting shipping cost', e);
                }
            }
            // For SCA/webstore we do not run other browser-only UI highlights
            return;
        }

        // SO ONLY: Warn that changing shippingcost on an already partially fulfilled /
        // pending billing order won't change what the customer is billed, since billed
        // shipping comes from the item fulfillment that has already been created.
        if (fieldId === 'shippingcost' && currentRecord.type === 'salesorder') {
            try {
                var newShippingCost = parseFloat(currentRecord.getValue({ fieldId: 'shippingcost' })) || 0;
                var shippingCostChanged = mode === 'edit' && newShippingCost !== originalShippingCost;

                var orderStatus = currentRecord.getText({ fieldId: 'status' }) || '';
                var isPartiallyFulfilled = orderStatus.indexOf('Partially Fulfilled') !== -1;
                var isPendingBilling = orderStatus.indexOf('Pending Billing') !== -1;

                if (shippingCostChanged && (isPartiallyFulfilled || isPendingBilling)) {
                    currentRecord.setValue({
                        fieldId: 'shippingcost',
                        value: originalShippingCost,
                        ignoreFieldChange: true
                    });

                    dialog.alert({
                        title: 'Shipping Cost Cannot Be Changed',
                        message: 'This order has already been fulfilled, in part or in full. Billed shipping comes from the first item fulfillment ' +
                            'which is where you will instead need to change the shipping cost.'
                    });
                }
            } catch (e) {
                log.error('Error in shippingcost fieldChanged reminder', e);
            }
        }

        // COMMON: When entity changes, run highlighting, credit checks, custbody5 highlight, location updates
        if (fieldId === 'entity') {
            try {
                updateLocationBasedOnSubsidiary(currentRecord);

                try {
                    context.currentRecord.setValue({ fieldId: 'paymentmethod', value: '' });
                    log.audit('Cleared paymentmethod in field changed', 'Entity changed, paymentmethod cleared');
                } catch (e) {
                    log.error('Error clearing paymentmethod in postSourcing', e);
                }

                try {
                    var customerStatus = currentRecord.getText({ fieldId: 'custbody13' });
                    var spendingBand = currentRecord.getText({ fieldId: 'custbody_customer_band' });
                    var permanentNotes = currentRecord.getValue({ fieldId: 'custbody_permanent_notes' });
                    var customerNotes = currentRecord.getValue({ fieldId: 'custbody5' });

                    var highlight = 'background-color:yellow; color:black; padding:4px;';
                    var plain = 'padding:4px;';

                    currentRecord.setValue({
                        fieldId: 'custbody_customer_status_html',
                        value: '<div><div class="smallgraytextnolink uir-label" style="margin-top:4px;">Customer Status</div>' +
                            '<div style="' + (customerStatus.length > 0 && customerStatus !== 'Open' ? highlight : plain) + '">' + customerStatus + '</div></div>',
                        ignoreFieldChange: true
                    });

                    currentRecord.setValue({
                        fieldId: 'custbody_customer_band_html',
                        value: '<div><div class="smallgraytextnolink uir-label" style="margin-top:4px;">Customer Band</div>' +
                            '<div style="' + (spendingBand === 'Intensive Care' ? highlight : plain) + '">' + spendingBand + '</div></div>',
                        ignoreFieldChange: true
                    });

                    currentRecord.setValue({
                        fieldId: 'custbody_permanent_notes_html',
                        value: '<div><div class="smallgraytextnolink uir-label" style="margin-top:4px;">Permanent Notes</div>' +
                            '<div style="' + plain + '">' + permanentNotes + '</div></div>',
                        ignoreFieldChange: true
                    });

                    currentRecord.setValue({
                        fieldId: 'custbody_customer_notes',
                        value: '<div><div class="smallgraytextnolink uir-label" style="margin-top:4px;">Customer Notes</div>' +
                            '<div style="' + (customerNotes.length > 0 ? highlight : plain) + '">' + customerNotes + '</div></div>',
                        ignoreFieldChange: true
                    });

                } catch (e) {
                    log.error('Error setting customer HTML fields', e);
                }

                runCreditCheck(currentRecord, mode);

                checkPaymentMethod(currentRecord);

            } catch (e) {
                log.error('Error in entity fieldChanged wrapper', e);
            }
        }

        // COMMON: When item changed on a line, clear custcol_rate_before_discount & custcol_discount, and sync location
        if (sublistId === 'item' && fieldId === 'item') {
            try {
                currentRecord.setCurrentSublistValue({ sublistId: 'item', fieldId: 'custcol_rate_before_discount', value: '' });
                currentRecord.setCurrentSublistValue({ sublistId: 'item', fieldId: 'custcol_discount', value: '' });
            } catch (e) {
                log.error('Error clearing rate_before_discount/discount', e);
            }
            try {
                var mainLocation = currentRecord.getValue({ fieldId: 'location' });
                var lineLocation = currentRecord.getCurrentSublistValue({ sublistId: 'item', fieldId: 'location' });
                if (mainLocation && mainLocation !== lineLocation) {
                    currentRecord.setCurrentSublistValue({ sublistId: 'item', fieldId: 'location', value: mainLocation });
                }
            } catch (e) {
                log.error('Error syncing line location', e);
            }
        }

        // When price level changes on line, set rate_before_discount unless Custom
        if (sublistId === 'item' && fieldId === 'price') {
            try {
                var priceLevelText = currentRecord.getCurrentSublistText({ sublistId: 'item', fieldId: 'price' });
                if (priceLevelText !== 'Custom') {
                    var currentRate = parseFloat(currentRecord.getCurrentSublistValue({ sublistId: 'item', fieldId: 'rate' })) || 0;
                    currentRecord.setCurrentSublistValue({ sublistId: 'item', fieldId: 'custcol_rate_before_discount', value: currentRate });
                } else {
                    currentRecord.setCurrentSublistValue({ sublistId: 'item', fieldId: 'custcol_rate_before_discount', value: '' });
                }
            } catch (e) {
                log.error('Error handling price field change', e);
            }
        }

        // For quantity change on lines, maintain line total weight (SO logic applied to Estimate too per request)
        if (sublistId === 'item' && fieldId === 'quantity') {
            try {
                var quantity = currentRecord.getCurrentSublistValue({ sublistId: 'item', fieldId: 'quantity' });
                var itemWeight = currentRecord.getCurrentSublistValue({ sublistId: 'item', fieldId: 'custcol_ci_itemweight' }) || 0.1;
                var totalWeight = quantity * itemWeight;
                currentRecord.setCurrentSublistValue({ sublistId: 'item', fieldId: 'custcol_lap_total_weight_on_line_', value: totalWeight });
            } catch (e) {
                log.error('Error calculating line total weight', e);
            }
        }
    }

    // validateLine - unified
    function validateLine(context) {
        // If Webstore, allow most validation to bypass (except specific webstore logic handled earlier)
        if (runtime.executionContext === runtime.ContextType.WEBSTORE) {
            return true;
        }

        var currentRecord = context.currentRecord;
        var sublistId = context.sublistId;
        var warningMessagesLocal = [];


        // COMMON: Available quantity check & Unavailable flag
        var quantity = currentRecord.getCurrentSublistValue({ sublistId: 'item', fieldId: 'quantity' }) || 0;
        var available = currentRecord.getCurrentSublistValue({ sublistId: 'item', fieldId: 'quantityavailable' }) || 0;
        var closed = currentRecord.getCurrentSublistValue({ sublistId: 'item', fieldId: 'isclosed' });

        try {
            if (!isNaN(quantity) && !isNaN(available)) {
                if (quantity > available && !closed) {
                    currentRecord.setCurrentSublistValue({ sublistId: 'item', fieldId: 'custcol_unavailable', value: '❗⚠️❗' });
                }
                else if (closed) {
                    currentRecord.setCurrentSublistValue({ sublistId: 'item', fieldId: 'custcol_unavailable', value: '🔒❌🔒' });
                }
                else if (!isNaN(quantity) && !isNaN(available) && quantity > available && closed) {
                    currentRecord.setCurrentSublistValue({ sublistId: 'item', fieldId: 'custcol_unavailable', value: '🔒❌🔒' });
                }
                else {
                    currentRecord.setCurrentSublistValue({ sublistId: 'item', fieldId: 'custcol_unavailable', value: '' });
                }
            }
        } catch (e) {
            log.error('Validate Line - Available Quantity and Closed Check', e);
        }

        // // Discount logic from Quote script (adapted to 2.0)
        // if (currentRecord.type === 'estimate') {
        //     try {
        //         var discountRaw = parseFloat(currentRecord.getCurrentSublistValue({ sublistId: sublistId, fieldId: 'custcol_discount' })) || 0;
        //         var currentRate = parseFloat(currentRecord.getCurrentSublistValue({ sublistId: sublistId, fieldId: 'rate' })) || 0;
        //         var rateBeforeDiscount = parseFloat(currentRecord.getCurrentSublistValue({ sublistId: sublistId, fieldId: 'custcol_rate_before_discount' })) || 0;
        //         var priceLevel = currentRecord.getCurrentSublistValue({ sublistId: sublistId, fieldId: 'price_display' });

        //         // If Custom pricing, remove discount and stop with alert
        //         if (priceLevel === 'Custom' && discountRaw) {
        //             currentRecord.setCurrentSublistValue({ sublistId: sublistId, fieldId: 'custcol_discount', value: '' });
        //             dialog.alert({
        //                 title: 'Custom Pricing',
        //                 message: 'This item already has a custom pricing and cannot be discounted further.'
        //             });
        //             return false;
        //         }

        //         if ((isNaN(rateBeforeDiscount) || rateBeforeDiscount === 0) && priceLevel === 'Custom') {
        //             return true;
        //         }

        //         if (priceLevel !== 'Custom' && (!rateBeforeDiscount || discountRaw === 0)) {
        //             currentRecord.setCurrentSublistValue({ sublistId: sublistId, fieldId: 'custcol_rate_before_discount', value: currentRate });
        //             rateBeforeDiscount = currentRate;
        //         }

        //         var newRate = rateBeforeDiscount * (1 - discountRaw / 100);
        //         newRate = parseFloat(newRate.toFixed(2));
        //         currentRecord.setCurrentSublistValue({ sublistId: sublistId, fieldId: 'rate', value: newRate });
        //     } catch (e) {
        //         log.error('Error in discount logic', e);
        //     }
        // }

        // Drop-ship and bulky item logic (Sales Order behavior applied to Estimates too)
        try {
            var salesRep = currentRecord.getText({ fieldId: 'salesrep' }) || 'your sales representative';
            var rate = currentRecord.getCurrentSublistValue({ sublistId: 'item', fieldId: 'rate' }) || 0;
            var amount = currentRecord.getCurrentSublistValue({ sublistId: 'item', fieldId: 'amount' }) || 0;
            var itemId = currentRecord.getCurrentSublistValue({ sublistId: 'item', fieldId: 'item' }) || null;
            var itemCode = currentRecord.getCurrentSublistText({ sublistId: 'item', fieldId: 'custcol17' }) || '';
            var location = currentRecord.getCurrentSublistValue({ sublistId: 'item', fieldId: 'location' }) || null;
            var dropQty = currentRecord.getCurrentSublistValue({ sublistId: 'item', fieldId: 'custcol_sd_qty_drop_ship' }) || 0;
            var POcreate = currentRecord.getCurrentSublistValue({ sublistId: 'item', fieldId: 'createpo' }) || 0;
            var dropIfUnavailable = currentRecord.getCurrentSublistValue({ sublistId: 'item', fieldId: 'custcol_drop_ship_unavailable' }) || 0;
            var bulkyItem = currentRecord.getCurrentSublistValue({ sublistId: 'item', fieldId: 'custcol_bulky_item' }) || false;
            var popupInfo = currentRecord.getCurrentSublistValue({ sublistId: 'item', fieldId: 'custcol_popup_info' });

            function getUnitCost(currentRecord) {
                return currentRecord.getCurrentSublistValue({ sublistId: 'item', fieldId: 'custcol_item_cost' })
                    || currentRecord.getCurrentSublistValue({ sublistId: 'item', fieldId: 'costestimaterate' })
                    || currentRecord.getCurrentSublistValue({ sublistId: 'item', fieldId: 'averagecost' }) || 0;
            }
            var unitCost = getUnitCost(currentRecord);

            // Unavailable handling already set above; handle drop ship createpo logic
            if (quantity >= dropQty && dropQty > 0) {
                if (mode === 'create' || mode === 'copy') {
                    currentRecord.setCurrentSublistValue({ sublistId: 'item', fieldId: 'createpo', value: 'DropShip' });
                } else {
                    if (!POcreate) {
                        dialog.alert({
                            title: 'Drop Ship Required',
                            message: "This item requires drop shipping. You must either create a new Sales Order or create a Drop Ship from the 'Create PO column' of the item in View Mode after saving this record."
                        });
                    }
                }
            }

            // When quantity > available and Drop If Unavailable true, set createpo when creating/copying
            if (quantity > available) {
                if ((dropIfUnavailable === true) && (mode === 'create' || mode === 'copy')) {
                    currentRecord.setCurrentSublistValue({ sublistId: 'item', fieldId: 'createpo', value: 'DropShip' });
                }
                if (mode !== 'create' && mode !== 'copy' && !POcreate && dropIfUnavailable === true) {
                    dialog.alert({
                        title: 'Drop Ship Required',
                        message: itemCode + " is unavailable but can be drop shipped. To do so, you must either create a new Sales Order or create a Drop Ship from the 'Create PO column' of the item in View Mode after saving this record."
                    });
                }
            }

            if (bulkyItem === true) {
                dialog.alert({
                    title: 'Bulky Item Warning',
                    message: itemCode + " is a bulky item and requires additional delivery charges. Contact " + salesRep + " for this information."
                });
            }
            if (popupInfo) {
                dialog.alert({
                    title: 'Item Information',
                    message: 'Item ' + itemCode + ' ' + popupInfo
                });
            }

            // Cost / gross profit estimates (same as Sales Order script)
            var estCost = 0, estCostPercent = 0;
            // if (itemId) {
            //     var fieldLookUp = search.lookupFields({
            //         type: 'item',
            //         id: itemId,
            //         columns: ['costestimate', 'averagecost', 'lastpurchaseprice', 'cost']
            //     });
            //     cost = parseFloat(fieldLookUp.costestimate) ||
            //         parseFloat(fieldLookUp.averagecost) ||
            //         parseFloat(fieldLookUp.lastpurchaseprice) ||
            //         parseFloat(fieldLookUp.cost) || 0;

            //     if (!cost && location) {
            //         cost = parseFloat(searchLocationAverageCost(itemId, location)) || 0;
            //     }
            // }

            amount = isNaN(amount) ? 0 : amount;
            quantity = isNaN(quantity) ? 0 : quantity;
            unitCost = isNaN(unitCost) ? 0 : unitCost;

            estCost = amount - (unitCost * quantity);
            estCostPercent = (amount !== 0) ? (estCost / amount) * 100 : 0;

            currentRecord.setCurrentSublistValue({ sublistId: 'item', fieldId: 'custcol_estextendedcost', value: parseFloat((unitCost * quantity || 0).toFixed(2)) });
            currentRecord.setCurrentSublistValue({ sublistId: 'item', fieldId: 'custcol_estgrossprofit', value: parseFloat((estCost || 0).toFixed(2)) });
            currentRecord.setCurrentSublistValue({ sublistId: 'item', fieldId: 'custcol_estgrossprofitpercent', value: parseFloat((estCostPercent || 0).toFixed(2)) });

            if (rate < unitCost) {
                warningMessagesLocal.push('The <b>rate</b> of ' + itemCode + ' is less than the <b>cost</b> price.');
            }

            // Date required vs expectedshipdate on line (common)
            var dateRequired = currentRecord.getValue({ fieldId: 'custbody_daterequired' });
            if (dateRequired) {
                var expectedShipDate = currentRecord.getCurrentSublistValue({ sublistId: 'item', fieldId: 'expectedshipdate' });
                if (!expectedShipDate) {
                    currentRecord.setCurrentSublistValue({ sublistId: 'item', fieldId: 'expectedshipdate', value: dateRequired });
                }
            }
        } catch (e) {
            Library.errorHandler('validateLine', e);
        }

        return true;
    }

    // validateField - includes phone and shipaddress validations
    var phoneValidationTimeout;
    function validateField(context) {
        if (runtime.executionContext === runtime.ContextType.WEBSTORE) {
            return true;
        }

        if (context.fieldId !== 'custbody_lpl_sitecontactphone' && context.fieldId !== 'shipaddress') return true;

        var currentRecord = context.currentRecord;

        if (context.fieldId === 'custbody_lpl_sitecontactphone') {
            clearTimeout(phoneValidationTimeout);
            phoneValidationTimeout = setTimeout(function () {
                var phone = currentRecord.getValue({ fieldId: 'custbody_lpl_sitecontactphone' }) || '';
                var phoneNoSpaces = phone.replace(/\s+/g, '');

                if (phoneNoSpaces.length !== 11 && phoneNoSpaces.length !== 0) {
                    dialog.alert({
                        title: 'Invalid Phone Number',
                        message: 'The Site Contact Phone must contain exactly 11 characters excluding spaces.'
                    });
                }
            }, 300);

            return true;
        }
        return true;
    }

    // sublistChanged: recalc estimated totals (applies to both SO and Estimate per request)
    function sublistChanged(context) {
        if (runtime.executionContext === runtime.ContextType.WEBSTORE) {
            return true;
        }

        var currentRecord = context.currentRecord;

        try {
            var lineCount = currentRecord.getLineCount({ sublistId: 'item' });
            var totalEstExtendedCost = 0;
            var totalGrossProfit = 0;

            if (lineCount > 0) {
                for (var i = 0; i < lineCount; i++) {
                    var lineEstExtendedCost = currentRecord.getSublistValue({ sublistId: 'item', fieldId: 'custcol_estextendedcost', line: i }) || 0;
                    totalEstExtendedCost += Number(lineEstExtendedCost);
                    var lineGrossProfit = currentRecord.getSublistValue({ sublistId: 'item', fieldId: 'custcol_estgrossprofit', line: i }) || 0;
                    totalGrossProfit += Number(lineGrossProfit);
                }

                currentRecord.setValue({ fieldId: 'custbody_estimatedextendedcost', value: parseFloat(totalEstExtendedCost).toFixed(2) });
                currentRecord.setValue({ fieldId: 'custbody_estimatedgrossprofit', value: parseFloat(totalGrossProfit).toFixed(2) });

                var revenue = currentRecord.getValue({ fieldId: 'subtotal' }) || 0;
                var grossProfitPercent = (revenue !== 0) ? (totalGrossProfit / revenue) * 100 : 0;
                currentRecord.setValue({ fieldId: 'custbody_estimatedgrossprofitpercent', value: parseFloat(grossProfitPercent).toFixed(1) + "%" });
            } else {
                currentRecord.setValue({ fieldId: 'custbody_estimatedextendedcost', value: 0 });
                currentRecord.setValue({ fieldId: 'custbody_estimatedgrossprofit', value: 0 });
                currentRecord.setValue({ fieldId: 'custbody_estimatedgrossprofitpercent', value: "" });
            }
        } catch (e) {
            Library.errorHandler('sublistChanged', e);
        }
    }

    // pageInit - sets mode and handles copy mode (Estimate -> SO) unavailable flags
    function pageInit(context) {
        if (runtime.executionContext === runtime.ContextType.WEBSTORE) {
            return true;
        }
        try {
            LibraryCustomEmails.setOverrideEmail(context.currentRecord);
        } catch (error) {
            log.error('Error in pageInit setOverrideEmail', error);
        }

        try {

            var rec = context.currentRecord;

            var customer = rec.getValue({ fieldId: 'entity' });
            var form = rec.getValue({ fieldId: 'customform' });
            var type = rec.type;

            log.audit('Page Init', 'Type: ' + type + ' Customer: ' + customer + ' Form: ' + form);

            if (customer == 1831) {

                var targetForm = null;

                if (type === 'salesorder') {
                    targetForm = 217;
                }

                if (type === 'estimate') {
                    targetForm = 218;
                }

                if (targetForm && form != targetForm) {

                    log.audit('Switching form', targetForm);

                    rec.setValue({
                        fieldId: 'customform',
                        value: targetForm
                    });

                }
            }

        } catch (error) {
            log.error('Error in pageInit', error);
        }

        try {
            mode = context.mode; // 'create', 'copy', 'edit'

            // Client scripts don't get oldRecord/newRecord like User Event scripts do,
            // so capture the as-loaded subtotal here (before the user edits anything)
            // to act as our "oldRecord" value for the credit check diff later.
            if (mode === 'edit') {
                originalOrderAmount = parseFloat(context.currentRecord.getValue({ fieldId: 'subtotal' })) || 0;
                log.audit('Captured original order amount', originalOrderAmount);

                originalShippingCost = parseFloat(context.currentRecord.getValue({ fieldId: 'shippingcost' })) || 0;
                log.audit('Captured original shipping cost', originalShippingCost);
            }

            if (mode === 'copy' && context.currentRecord.type === 'salesorder') {
                var currentRecord = context.currentRecord;

                // Backup driver delivery notes
                var driverNotes = currentRecord.getValue({ fieldId: 'custbody_driver_delivery_report' });
                currentRecord.setValue({ fieldId: 'custbody_hist_driver_delivery_report', value: driverNotes });
                currentRecord.setValue({ fieldId: 'custbody_driver_delivery_report', value: '' });

                // Set unavailable flags on lines based on quantity vs available and closed status
                var lineCount = currentRecord.getLineCount({ sublistId: 'item' });
                for (var i = 0; i < lineCount; i++) {
                    currentRecord.selectLine({ sublistId: 'item', line: i });

                    var quantity = currentRecord.getCurrentSublistValue({ sublistId: 'item', fieldId: 'quantity' });
                    var available = currentRecord.getCurrentSublistValue({ sublistId: 'item', fieldId: 'quantityavailable' });
                    var closed = currentRecord.getCurrentSublistValue({ sublistId: 'item', fieldId: 'isclosed' });

                    var unavailableFlag = '';
                    if (closed) {
                        unavailableFlag = '🔒❌🔒';
                    }
                    else if (!isNaN(quantity) && !isNaN(available) && quantity > available && closed) {
                        unavailableFlag = '🔒❌🔒';
                    }
                    else if (!isNaN(quantity) && !isNaN(available) && quantity > available && !closed) {
                        unavailableFlag = '❗⚠️❗';
                    }

                    currentRecord.setCurrentSublistValue({ sublistId: 'item', fieldId: 'custcol_unavailable', value: unavailableFlag });
                    currentRecord.commitLine({ sublistId: 'item' });
                }

                runCreditCheck(context.currentRecord, mode);
            }

        } catch (error) {
            log.error('Error in pageInit', error);
        }

        try {
            checkPaymentMethod(context.currentRecord);
        } catch (error) {
            log.error('Error in checkPaymentMethod', error);
        }
    }

    // postSourcing - handle entity post sourcing and clear paymentmethod on non-webstore
    function postSourcing(context) {
        if (runtime.executionContext === runtime.ContextType.WEBSTORE) {
            return true;
        }
        var contextRecord = context.currentRecord.getText({ fieldId: 'custbody_sd_context' });
        if (contextRecord === 'Web') {
            return true;
        }

        var paymentMethod = context.currentRecord.getText({ fieldId: 'paymentmethod' });
        if (paymentMethod === 'T-Card') {
            return true;
        }

        if (context.fieldId === 'entity') {
            var currentRecord = context.currentRecord;

            try {
                LibraryCustomEmails.setOverrideEmail(context.currentRecord);
            } catch (e) {
                log.error('Error in postSourcing setOverrideEmail', e);
            }

            // Clear payment method for non-webstore contexts (SO behavior)
            try {
                context.currentRecord.setValue({ fieldId: 'paymentmethod', value: '' });
                log.audit('Cleared paymentmethod in postSourcing', 'Entity changed, paymentmethod cleared');
            } catch (e) {
                log.error('Error clearing paymentmethod in postSourcing', e);
            }
        }
    }

    // saveRecord - unified checks: phone formatting, phone length, missing address, future date required, missing rates
    function saveRecord(context) {
        if (runtime.executionContext === runtime.ContextType.WEBSTORE) {
            return true;
        }

        var currentRecord = context.currentRecord;
        // NOTE: saveRecord's context does not include `mode` — rely on the
        // module-level `mode` variable set in pageInit instead.
        // 🔒 BLOCK SAVE ON SALES ORDER IF CREDIT CHECK FAILED
        // 🔄 Re-run credit check on save to ensure latest customer status
        if (currentRecord.type === 'salesorder') {
            log.audit("Mode is", mode);
            runCreditCheck(currentRecord, mode);

            if (creditViolation) {
                dialog.alert({
                    title: 'Credit Block',
                    message: 'This customer failed one or more credit checks. You cannot save this Sales Order.'
                });
                return false;
            }
        }

        try {
            var phone = currentRecord.getValue({ fieldId: 'custbody_lpl_sitecontactphone' }) || '';
            var phoneNoSpaces = phone.replace(/\s+/g, '');
            currentRecord.setValue({ fieldId: 'custbody_lpl_sitecontactphone', value: phoneNoSpaces });

            var subsidiary = currentRecord.getValue({ fieldId: 'subsidiary' });
            if (subsidiary == 3) {
                if (phoneNoSpaces.length !== 11 && phoneNoSpaces.length !== 0) {
                    dialog.alert({ title: 'Invalid Phone Number', message: 'The Site Contact Phone must contain exactly 11 characters excluding spaces.' });
                    return false;
                }
            }

            var warningMessages = [];

            // Date Required future check
            var dateRequired = currentRecord.getValue({ fieldId: 'custbody_daterequired' });
            if (dateRequired) {
                var today = new Date();
                today.setHours(0, 0, 0, 0);
                var requiredDate = new Date(dateRequired);
                if (requiredDate > today) {
                    warningMessages.push('The record you are saving has a <b>Date Required</b> value that is in the future.');
                }
            }

            // Address presence
            var address = currentRecord.getValue({ fieldId: 'shipaddress' });
            if (!address) {
                warningMessages.push('The record you are saving is missing the <b>address</b>.');
                if (currentRecord.type === 'salesorder') {
                    dialog.alert({
                        title: 'Missing Address',
                        message: 'The record you are saving is missing the <b>address</b>. You cannot save this Sales Order.'
                    });
                    return false;
                }
            }

            // Rate checks per line
            var lineCount = currentRecord.getLineCount({ sublistId: 'item' });
            for (var i = 0; i < lineCount; i++) {
                var rate = currentRecord.getSublistValue({ sublistId: 'item', fieldId: 'rate', line: i });
                if (rate === '' || rate === null || rate === undefined) {
                    warningMessages.push('The record you are saving is missing the <b>rate</b> for one or more of the items.');
                    break;
                }
            }

            if (warningMessages.length > 0) {
                dialog.alert({
                    title: 'Reminder',
                    message: warningMessages.join('<br><br>')
                });
            }

        } catch (e) {
            log.error('Error in saveRecord', e);
        }

        try {
            var paymentMethod = currentRecord.getText({ fieldId: 'paymentmethod' });
            log.audit('Payment Method on Save', paymentMethod);
            if (paymentMethod === 'T-Card') {
                var user = currentRecord.getValue({ fieldId: 'custbody_tcard_user' });
                if (!user) {
                    dialog.alert({
                        title: 'Missing T-Card User',
                        message: 'You must select a T-Card User in the Billing Subtab before saving this record.'
                    });
                    return false;
                }
            }
        } catch (e) {
            log.error('Error checking T-Card user', e);
        }

        return true;
    }

    /// ---- Helper Functions ---- ///

    function checkPaymentMethod(currentRecord) {
        try {
            var paymentMethod = currentRecord.getValue({ fieldId: 'custbody_pref_payment_method' });
            if (paymentMethod) {
                currentRecord.setValue({ fieldId: 'paymentmethod', value: paymentMethod });
                currentRecord.setValue({ fieldId: 'terms', value: null });
                log.audit('Preferred Payment Method Set', 'Set payment method to preferred: ' + paymentMethod);
            }
        } catch (e) {
            log.error('Error in checkPaymentMethod', e);
        }
    }

    function runCreditCheck(currentRecord, mode) {
        creditViolation = false;

        try {
            var customerId = currentRecord.getValue({ fieldId: 'entity' });
            if (!customerId) return;

            var customerData = search.lookupFields({
                type: search.Type.CUSTOMER,
                id: customerId,
                columns: ['custentity_credit_hold_override', 'balance', 'overduebalance', 'creditlimit', 'daysoverdue', 'unbilledorders']
            });

            var credithold = customerData.custentity_credit_hold_override[0] ? customerData.custentity_credit_hold_override[0].text : null;
            var daysoverdue = parseInt(customerData.daysoverdue) || 0;

            function toNum(v) {
                if (!v) return 0;
                return parseFloat(String(v).trim()) || 0;
            }

            var balance = toNum(customerData.balance);
            var overduebalance = toNum(customerData.overduebalance);
            var creditlimit = toNum(customerData.creditlimit);
            var unbilledorders = toNum(customerData.unbilledorders);
            var orderAmount;

            if (mode === 'edit') {
                // unbilledorders already includes this record's existing (saved) amount,
                // so only the INCREASE since it was loaded should be added on top —
                // otherwise the original amount gets counted twice.
                var newRecordAmount = toNum(currentRecord.getValue({ fieldId: 'subtotal' }));
                var oldRecordAmount = toNum(originalOrderAmount);
                var amountDifference = newRecordAmount - oldRecordAmount;

                orderAmount = amountDifference > 0 ? amountDifference : 0;

                log.audit(
                    "Edit Mode Order Amount Difference",
                    "Old (oldRecord): " + oldRecordAmount + " | New (newRecord): " + newRecordAmount +
                    " | Difference used: " + orderAmount
                );
            } else {
                log.audit("Add Order Amount", "Mode is " + mode);
                orderAmount = toNum(currentRecord.getValue({ fieldId: 'subtotal' }));
            }

            var totalBalance = balance + unbilledorders + orderAmount;

            var isSO = (currentRecord.type === 'salesorder');

            function alertMsg(msg) {
                dialog.alert({
                    title: 'Credit Warning',
                    message: msg
                });
            }

            if (credithold === 'On') {
                creditViolation = true;
                alertMsg('This customer is on manual credit hold. Please check with the finance team. You cannot save this record.');
            }

            if (credithold === 'Off') {
                // Credit hold is manually disabled — skip all auto checks regardless of balance or overdue status
            }

            if (credithold === 'Auto') {
                if (overduebalance > 0 && daysoverdue > 17) {
                    creditViolation = true;
                    alertMsg('This customer has an overdue balance and is more than 17 days past due. Please check with the finance team. You cannot save this record.');
                } else if (balance + unbilledorders > creditlimit && creditlimit > 0) {
                    // Existing balance + unbilled orders already exceeds the limit before this order
                    creditViolation = true;
                    alertMsg('This customer\'s existing balance and unbilled orders already exceed their credit limit. Please check with the finance team. You cannot save this record.');
                } else if (totalBalance > creditlimit && creditlimit > 0) {
                    // This order specifically pushes them over the limit
                    creditViolation = true;
                    alertMsg(
                        'This order would exceed the customer\'s credit limit. ' +
                        'Credit Limit: ' + creditlimit.toFixed(2) + ' | ' +
                        'Current Balance + Unbilled: ' + (balance + unbilledorders).toFixed(2) + ' | ' +
                        'This Order: ' + orderAmount.toFixed(2) + ' | ' +
                        'Total Would Be: ' + totalBalance.toFixed(2) + '. ' +
                        'Please check with the finance team. You cannot save this record.'
                    );
                }
            }

        } catch (e) {
            log.error('Error in runCreditCheck', e);
        }
    }

    function setFieldDataHighlight(fieldId, on) {
        var color = on ? 'yellow' : '';

        var wrapper = document.querySelector('[data-field-name="' + fieldId + '"]');

        if (!wrapper) {
            log.error('Field wrapper not found: ' + fieldId);
            return;
        }

        var dataSpan = wrapper.querySelector('.uir-field');

        if (!dataSpan) {
            log.error('Data span not found for field: ' + fieldId);
            return;
        }

        dataSpan.style.background = color;
    }

    function ascendToTag(el, tag) {
        tag = tag.toUpperCase();
        while (el && el.tagName !== tag) el = el.parentElement;
        return el || null;
    }

    function updateLocationBasedOnSubsidiary(currentRecord) {
        var subsidiary = currentRecord.getValue({ fieldId: 'subsidiary' });
        var locationValue;
        if (subsidiary == 3) {
            locationValue = 4;
        } else {
            locationValue = 6;
        }
        currentRecord.setValue({
            fieldId: 'location',
            value: locationValue
        });
    }

    // function searchLocationAverageCost(itemId, location) {
    //     var filters = [];
    //     var columns = [];
    //     var results = null;
    //     var locationAverageCost = null;
    //     var cost = 0;

    //     try {
    //         filters.push(search.createFilter({ name: 'internalid', operator: search.Operator.ANYOF, values: itemId }));
    //         filters.push(search.createFilter({ name: 'locationaveragecost', operator: search.Operator.ISNOTEMPTY }));
    //         filters.push(search.createFilter({ name: 'inventorylocation', operator: search.Operator.ANYOF, values: location }));

    //         columns.push(search.createColumn({ name: 'location' }));
    //         columns.push(search.createColumn({ name: 'locationaveragecost' }));

    //         results = Library.getAllSearchResults('item', filters, columns);

    //         if (results != null && results.length > 0) {
    //             locationAverageCost = results[0].getValue({ name: 'locationaveragecost' }) || 0;
    //             cost = parseFloat(locationAverageCost).toFixed(2);
    //         } else {
    //             cost = 0;
    //         }
    //     } catch (e) {
    //         Library.errorHandler('searchLocationAverageCost', e);
    //     }
    //     return cost;
    // }

    // Set override email util (from Sales Order file)
    function setOverrideEmail(newRec) {
        var entityId = null;
        var useEmailId = null;
        var emailId = null;
        var emailValues = null;

        try {
            entityId = newRec.getValue({ fieldId: 'entity' });

            if (entityId) {
                useEmailId = 'custentity_useemail_' + newRec.type;
                emailId = 'custentity_email_' + newRec.type;
                emailValues = search.lookupFields({ type: 'entity', id: entityId, columns: [useEmailId, emailId] });

                if (emailValues[useEmailId] == true) {
                    newRec.setValue({ fieldId: 'email', value: emailValues[emailId] });
                }
            }
        } catch (e) {
            Library.errorHandler('setOverrideEmail', e);
        }
    }

    return {
        fieldChanged: fieldChanged,
        validateLine: validateLine,
        validateField: validateField,
        sublistChanged: sublistChanged,
        pageInit: pageInit,
        postSourcing: postSourcing,
        saveRecord: saveRecord
    };
});
