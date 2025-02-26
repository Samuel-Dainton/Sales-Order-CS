# Sales-Order-CS
A collection of minor functions that are performed on a Sales Order record during user interaction. 

* If the TT Extra Delivery Charges field is edited, the Shipping Cost field is updated with the same value.
* If the Quantity field on an item line is edited, the Total Weight is calculated using Item Weight * Quantity
* If the Customer is selected and the Customer's Account Status has a status of 'Take Card Payment with order', the customer is highlighted yellow. (Is 'Take Card Payment with order' the correct status that causes the highlighting? It appears correct but I had it in my head as a different value.)
* When adding and interacting with item lines, the Est. Extended Cost, Est. Gross Profit and Est. Gross Profit & columns are calculated.
* When adding a phone number to the site contact, the phone number should be 11 characters long, containing no characters or spaces. A popup is displayed both when trying to enter an incorrect number or when saving the record.
* If there is data in the Carriage Matrix field, it should be highlighted in yellow.
* In the communications subtab, the email should be set to the appropriate customer email from the customer record.
* If the Date Required is in the future, a popup will appear to notify you of this when saving the record.
