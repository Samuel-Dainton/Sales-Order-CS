/**
 * @NApiVersion 2.1
 * @NScriptType ClientScript
 */
define(['N/log', 'N/runtime', 'N/ui/dialog', 'N/search', 'SuiteScripts/FHL/Library.FHL.2.0.js', 'SuiteScripts/FHL/Custom Emails/Library.CustomEmails.js'],
    function (log, runtime, dialog, search, Library, LibraryCustomEmails) {
        'use strict';

        function fieldChanged(context) {
            log.audit('Field Changed Func Triggered. Context:', runtime.executionContext);
            var currentRecord = context.currentRecord;
            var fieldId = context.fieldId;
            var sublistId = context.sublistId;

            if (runtime.executionContext === runtime.ContextType.WEBSTORE) {

                log.error('webstore executed:', runtime.executionContext);
                log.error('fieldId:', fieldId);

                // Shipping Extra Charges functionality
                if (fieldId === 'custbody_tt_extra_delivery_charges') {
                    var newShippingCost = currentRecord.getValue({ fieldId });

                    log.error('newShippingCost:', newShippingCost);
                    currentRecord.setValue({
                        fieldId: 'shippingcost',
                        value: parseFloat(newShippingCost),
                        ignoreFieldChange: false
                    });
                    log.debug('Shipping cost updated', newShippingCost);
                }
            }

            // Line Level Total Weight functionality
            if (sublistId === 'item' && fieldId === 'quantity') {
                try {
                    var quantity = currentRecord.getCurrentSublistValue({ sublistId: 'item', fieldId: 'quantity' });
                    var itemWeight = currentRecord.getCurrentSublistValue({ sublistId: 'item', fieldId: 'custcol_ci_itemweight' });
                    var totalWeight = quantity * itemWeight;
                    currentRecord.setCurrentSublistValue({ sublistId: 'item', fieldId: 'custcol_lap_total_weight_on_line_', value: totalWeight });
                    log.debug('Total weight calculated', totalWeight);
                } catch (error) {
                    log.error('Error in calculating total weight', error);
                }            
            }

            // Highlight Customer Status and Carriage Matrix functionality
            if (fieldId === 'entity') {
                try {
                    updateLocationBasedOnSubsidiary(context.currentRecord);
                    var customerStatus = currentRecord.getValue({ fieldId: 'custbody13' });
                    var highlightStatus = Library.lookUpParameters('customerstatus', 'Highlight');
                    var element = document.getElementById('custbody13_lbl').parentElement;

                    if (customerStatus === highlightStatus) {
                        element.parentNode.childNodes[0].childNodes[0].style.background = 'yellow';
                        element.parentNode.childNodes[1].style.background = 'yellow';
                    } else {
                        element.parentNode.childNodes[0].childNodes[0].style.background = 'none';
                        element.parentNode.childNodes[1].style.background = 'none';
                    }
                    log.debug('Customer status highlighted', customerStatus);
                } catch (error) {
                    log.error('Error in highlighting customer status', error);
                }

                try {
                    var custbody5Value = currentRecord.getValue({ fieldId: 'custbody5' });
                    if (custbody5Value) {
                        var element = document.getElementById('custbody5').parentElement;
                        element.parentNode.childNodes[0].childNodes[0].style.background = 'yellow';
                        element.parentNode.childNodes[1].style.background = 'yellow';
                    }

                    log.debug('Customer field changed', 'custbody5 highlighting logic executed.');
                } catch (error) {
                    log.error('Error in fieldChanged for custbody5', error);
                }
            }
        }

        function validateLine(context) {
            log.audit('Validate Line Func Triggered. Context:', runtime.executionContext);
            var currentRecord = context.currentRecord;
            var amount = currentRecord.getCurrentSublistValue({ sublistId: 'item', fieldId: 'amount' }) || 0;
            var itemId = currentRecord.getCurrentSublistValue({ sublistId: 'item', fieldId: 'item' }) || null;
            var location = currentRecord.getCurrentSublistValue({ sublistId: 'item', fieldId: 'location' }) || null;
            var quantity = currentRecord.getCurrentSublistValue({ sublistId: 'item', fieldId: 'quantity' }) || 0;
            var available = currentRecord.getCurrentSublistValue({ sublistId: 'item', fieldId: 'quantityavailable' }) || 0;
            var cost = 0, estCost = 0, estCostPercent = 0;
            
            try {
                log.debug('Unavailable Check - Values', {
                    quantity: quantity,
                    available: available
                });
            
                if (!isNaN(quantity) && !isNaN(available)) {
                    if (quantity > available) {
                        currentRecord.setCurrentSublistValue({
                            sublistId: 'item',
                            fieldId: 'custcol_unavailable',
                            value: '❗⚠️❗'
                        });
                        log.debug('Unavailable flag set', 'Quantity exceeds available');
                    } else {
                        currentRecord.setCurrentSublistValue({
                            sublistId: 'item',
                            fieldId: 'custcol_unavailable',
                            value: ''
                        });
                        log.debug('Unavailable flag cleared', 'Quantity is within available');
                    }
                } else {
                    log.debug('Unavailable flag skipped', 'Invalid numeric values');
                }
            } catch (error) {
                log.error('Error setting unavailable flag', error);
            }     

            try {
                // Get cost from lookup if item exists
                if (itemId) {
                    var fieldLookUp = search.lookupFields({
                        type: 'item',
                        id: itemId,
                        columns: ['costestimate', 'averagecost', 'lastpurchaseprice', 'cost']
                    });

                    // Assign cost with safety checks
                    cost = parseFloat(fieldLookUp.costestimate) ||
                        parseFloat(fieldLookUp.averagecost) ||
                        parseFloat(fieldLookUp.lastpurchaseprice) ||
                        parseFloat(fieldLookUp.cost) || 0;

                    // Use location average cost if needed
                    if (!cost && location) {
                        cost = parseFloat(searchLocationAverageCost(itemId, location)) || 0;
                    }
                }

                // 🔹 Ensure valid numbers before calculation
                amount = isNaN(amount) ? 0 : amount;
                quantity = isNaN(quantity) ? 0 : quantity;
                cost = isNaN(cost) ? 0 : cost;

                estCost = amount - (cost * quantity);
                estCostPercent = (amount !== 0) ? (estCost / amount) * 100 : 0;

                // 🔹 Ensure values are numbers before setting fields
                currentRecord.setCurrentSublistValue({ sublistId: 'item', fieldId: 'custcol_estextendedcost', value: cost * quantity || 0 });
                currentRecord.setCurrentSublistValue({ sublistId: 'item', fieldId: 'custcol_estgrossprofit', value: estCost || 0 });
                currentRecord.setCurrentSublistValue({ sublistId: 'item', fieldId: 'custcol_estgrossprofitpercent', value: parseFloat(estCostPercent).toFixed(1) || 0 });


                // Check the Date Requires vs Expected Ship Date line
                var dateRequired = currentRecord.getValue({ fieldId: 'custbody_daterequired' });
                // Exit early if custbody_daterequired is empty
                if (!dateRequired) {
                    return true;
                }

                var expectedShipDate = currentRecord.getCurrentSublistValue({
                    sublistId: 'item',
                    fieldId: 'expectedshipdate'
                });
                log.debug('Expected Ship Date', expectedShipDate);

                // Only set if expectedshipdate is currently empty
                if (!expectedShipDate) {
                    log.debug('Setting Date', dateRequired);
                    currentRecord.setCurrentSublistValue({
                        sublistId: 'item',
                        fieldId: 'expectedshipdate',
                        value: dateRequired
                    });
                }

            } catch (error) {
                Library.errorHandler('validateLine', error);
            }       
            return true;
        }

        let phoneValidationTimeout;

        function validateField(context) {
            log.audit('Validate Field Func Triggered. Context:', runtime.executionContext);
            if (context.fieldId !== 'custbody_lpl_sitecontactphone') return true;

            clearTimeout(phoneValidationTimeout); // Clear any existing timeout to prevent multiple executions

            phoneValidationTimeout = setTimeout(() => {
                const currentRecord = context.currentRecord;
                const phone = currentRecord.getValue({ fieldId: 'custbody_lpl_sitecontactphone' }) || '';
                const phoneNoSpaces = phone.replace(/\s+/g, ''); // Remove spaces

                if (phoneNoSpaces.length !== 11 && phoneNoSpaces.length !== 0) {
                    dialog.alert({
                        title: 'Invalid Phone Number',
                        message: 'The Site Contact Phone must contain exactly 11 characters excluding spaces.'
                    });
                }
            }, 300); // Delay execution by 300ms to improve performance

            return true;
        }

        function sublistChanged(context) {
            log.audit('Sublist Changed Func Triggered. Context:', runtime.executionContext);
            var currentRecord = null;
            var lineCount = null;
            var lineGrossProfit = null;
            var totalGrossProfit = null;
            var cost = null;
            var lineEstExtendedCost = null;
            var totalEstExtenededCost = null;
            var revenue = null;
            var grossProfitPercent = null;

            try {
                currentRecord = context.currentRecord;
                lineCount = currentRecord.getLineCount({ sublistId: 'item' });
                if (lineCount > 0) {
                    for (var i = 0; i < lineCount; i++) // 1.0.2
                    {
                        lineEstExtendedCost = currentRecord.getSublistValue({ sublistId: 'item', fieldId: 'custcol_estextendedcost', line: i }) || 0;
                        totalEstExtenededCost += Number(lineEstExtendedCost);
                        lineGrossProfit = currentRecord.getSublistValue({ sublistId: 'item', fieldId: 'custcol_estgrossprofit', line: i }) || 0;
                        totalGrossProfit += Number(lineGrossProfit);
                    }

                    cost = parseFloat(totalEstExtenededCost).toFixed(2);
                    currentRecord.setValue({ fieldId: 'custbody_estimatedextendedcost', value: cost });
                    cost = parseFloat(totalGrossProfit).toFixed(2);
                    currentRecord.setValue({ fieldId: 'custbody_estimatedgrossprofit', value: cost });
                    revenue = currentRecord.getValue({ fieldId: 'subtotal' });
                    grossProfitPercent = (totalGrossProfit / revenue) * 100;
                    cost = parseFloat(grossProfitPercent).toFixed(1);
                    currentRecord.setValue({ fieldId: 'custbody_estimatedgrossprofitpercent', value: cost + "%" });
                }
                else {
                    currentRecord.setValue({ fieldId: 'custbody_estimatedextendedcost', value: 0 });
                    currentRecord.setValue({ fieldId: 'custbody_estimatedgrossprofit', value: 0 });
                    currentRecord.setValue({ fieldId: 'custbody_estimatedgrossprofitpercent', value: "" });
                }
            }
            catch (e) {
                Library.errorHandler('sublistChanged', e);
            }
        }

        function searchLocationAverageCost(itemId, location) {
            var filters = [];
            var columns = [];
            var results = null;
            var locationAverageCost = null;
            var cost = 0; //1.1.0

            try {
                filters.push(search.createFilter({ name: 'internalid', operator: search.Operator.ANYOF, values: itemId }));
                filters.push(search.createFilter({ name: 'locationaveragecost', operator: search.Operator.ISNOTEMPTY }));
                filters.push(search.createFilter({ name: 'inventorylocation', operator: search.Operator.ANYOF, values: location }));

                columns.push(search.createColumn({ name: 'location' }));
                columns.push(search.createColumn({ name: 'locationaveragecost' }));

                results = Library.getAllSearchResults('item', filters, columns);

                if (results != null) {
                    locationAverageCost = results[0].getValue({ name: 'locationaveragecost' }) || 0; //1.1.0 "|| 0" added
                    cost = parseFloat(locationAverageCost).toFixed(2);
                }
                else //1.1.0
                {
                    cost = 0; //1.1.0
                }
            }
            catch (e) {
                Library.errorHandler('searchLocationAverageCost', e);
            }
            return cost;
        }

        function pageInit(context) {
            log.audit('Script Loaded, PageInit Triggered. Context:', runtime.executionContext);
            try {
                LibraryCustomEmails.setOverrideEmail(context.currentRecord);
                log.debug('Custom email set during page initialization');
            } catch (error) {
                log.error('Error in pageInit', error);
            }
        }

        function postSourcing(context) {
            log.audit('Post Sourcing Func Triggered. Context:', runtime.executionContext);
            try {
                if (context.fieldId === 'entity') {
                    LibraryCustomEmails.setOverrideEmail(context.currentRecord);
                    log.debug('Custom email set during post sourcing');
                }
                // var fieldId = context.fieldId;
                // if (fieldId === 'subsidiary') {
                //     updateLocationBasedOnSubsidiary(context.currentRecord);
                // }
            } catch (error) {
                log.error('Error in postSourcing', error);
            }
        }

        function updateLocationBasedOnSubsidiary(currentRecord) {
            var subsidiary = currentRecord.getValue({ fieldId: 'subsidiary' });
            log.debug('Subsidiary', subsidiary);

            var locationValue;
            if (subsidiary == 3) {
                locationValue = 4;
            } else {
                locationValue = 6;
            }
            log.debug('Location', locationValue);
            currentRecord.setValue({
                fieldId: 'location',
                value: locationValue,
            });
        }

        function saveRecord(context) {
            log.audit('Save Record Func Triggered. Context:', runtime.executionContext);
            if (runtime.executionContext === runtime.ContextType.WEBSTORE) {
                return true;

            }
            const currentRecord = context.currentRecord;
            // Get phone field value and remove spaces
            let phone = currentRecord.getValue({ fieldId: 'custbody_lpl_sitecontactphone' }) || '';
            let phoneNoSpaces = phone.replace(/\s+/g, ''); // Remove spaces

            // Update the field with the cleaned phone number
            currentRecord.setValue({ fieldId: 'custbody_lpl_sitecontactphone', value: phoneNoSpaces });

            // Validate phone number length
            var subsidiary = currentRecord.getValue({ fieldId: 'subsidiary' });
            if (subsidiary == 3) {
                if (phoneNoSpaces.length !== 11) {
                    dialog.alert({
                        title: 'Invalid Phone Number',
                        message: 'The Site Contact Phone must contain exactly 11 characters excluding spaces.'
                    });
                    return false; // Prevent saving
                }
            }

            // Check date required field
            const dateRequired = currentRecord.getValue({ fieldId: 'custbody_daterequired' });
            if (dateRequired) {
                const today = new Date();
                today.setHours(0, 0, 0, 0); // Normalize to the start of the day
                const requiredDate = new Date(dateRequired);

                if (requiredDate > today) {
                    dialog.alert({
                        title: 'Reminder',
                        message: 'The record you are saving has a Date Required value that is in the future.'
                    });
                }
            }

            return true; // Allow Save
        }

        return {
            fieldChanged,
            validateLine,
            validateField,
            sublistChanged,
            pageInit,
            postSourcing,
            saveRecord
        };
    });
